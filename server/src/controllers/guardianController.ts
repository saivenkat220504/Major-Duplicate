import { Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import prisma from '../prisma/client';
import { AuthRequest } from '../middleware/auth';
import { sendGuardianOtpEmail, sendGuardianNotificationEmail } from '../services/mailerService';
import { encryptPassword, decryptPassword } from '../utils/crypto';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_EXPIRATION_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * POST /api/guardian/email-config
 * Saves or updates SMTP App Password configuration for a specific guardian email.
 */
export async function saveGuardianEmailConfig(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { guardianEmail, smtpUser, smtpAppPassword } = req.body;

    if (!guardianEmail || typeof guardianEmail !== 'string' || !EMAIL_REGEX.test(guardianEmail.trim())) {
      return res.status(400).json({ success: false, message: 'Valid guardian email address is required' });
    }

    if (!smtpUser || typeof smtpUser !== 'string' || !EMAIL_REGEX.test(smtpUser.trim())) {
      return res.status(400).json({ success: false, message: 'Valid SMTP Gmail address is required' });
    }

    if (!smtpAppPassword || typeof smtpAppPassword !== 'string' || smtpAppPassword.trim().length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Valid 16-character Gmail App Password is required',
      });
    }

    const normalizedGuardianEmail = guardianEmail.trim().toLowerCase();
    const normalizedSmtpUser = smtpUser.trim().toLowerCase();
    const cleanAppPassword = smtpAppPassword.trim().replace(/\s+/g, ''); // strip spaces from App Password format

    // Encrypt password before storing at rest
    const encryptedAppPassword = encryptPassword(cleanAppPassword);

    await prisma.guardianEmailConfig.upsert({
      where: { userId_guardianEmail: { userId, guardianEmail: normalizedGuardianEmail } },
      update: {
        smtpUser: normalizedSmtpUser,
        smtpAppPassword: encryptedAppPassword,
      },
      create: {
        userId,
        guardianEmail: normalizedGuardianEmail,
        smtpUser: normalizedSmtpUser,
        smtpAppPassword: encryptedAppPassword,
      },
    });

    return res.json({
      success: true,
      message: 'Guardian email SMTP configuration saved successfully.',
      configured: true,
      guardianEmail: normalizedGuardianEmail,
      smtpUser: normalizedSmtpUser,
    });
  } catch (err: any) {
    console.error('[GuardianController] Error saving guardian email config:', err);
    return res.status(500).json({ success: false, message: 'Failed to save guardian email configuration' });
  }
}

/**
 * GET /api/guardian/email-config/:guardianEmail
 * Checks if email configuration exists for a specific guardian.
 */
export async function getGuardianEmailConfig(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const rawEmail = req.params.guardianEmail;
    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(400).json({ success: false, message: 'Guardian email parameter is required' });
    }

    const normalizedGuardianEmail = rawEmail.trim().toLowerCase();

    const config = await prisma.guardianEmailConfig.findUnique({
      where: { userId_guardianEmail: { userId, guardianEmail: normalizedGuardianEmail } },
    });

    if (!config) {
      return res.json({
        success: true,
        configured: false,
        guardianEmail: normalizedGuardianEmail,
      });
    }

    return res.json({
      success: true,
      configured: true,
      guardianEmail: config.guardianEmail,
      smtpUser: config.smtpUser,
      // NOTE: Password is NEVER returned in response
    });
  } catch (err: any) {
    console.error('[GuardianController] Error fetching guardian email config:', err);
    return res.status(500).json({ success: false, message: 'Failed to check guardian email config' });
  }
}

/**
 * POST /api/guardian/send-otp
 * Generates secure OTP and dispatches email using stored guardian SMTP credentials.
 */
export async function sendOtp(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { email } = req.body;
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if guardian email config exists for this user + guardian
    const config = await prisma.guardianEmailConfig.findUnique({
      where: { userId_guardianEmail: { userId, guardianEmail: normalizedEmail } },
    });

    if (!config) {
      return res.status(400).json({
        success: false,
        message: 'Guardian Gmail App Password configuration missing. Please complete setup step first.',
        requiresConfig: true,
      });
    }

    // Decrypt App Password
    const decryptedPassword = decryptPassword(config.smtpAppPassword);
    if (!decryptedPassword) {
      return res.status(400).json({
        success: false,
        message: 'Invalid encrypted App Password. Please re-enter guardian App Password.',
      });
    }

    // Check resend cooldown (60 seconds)
    const existingOtp = await prisma.guardianOtp.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (existingOtp) {
      const secondsSinceLastOtp = (Date.now() - new Date(existingOtp.createdAt).getTime()) / 1000;
      if (secondsSinceLastOtp < RESEND_COOLDOWN_SECONDS) {
        const remainingCooldown = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastOtp);
        return res.status(429).json({
          success: false,
          message: `Please wait ${remainingCooldown} seconds before requesting a new OTP.`,
        });
      }
    }

    // Generate secure 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000);

    // Delete any previous pending OTP for this user
    await prisma.guardianOtp.deleteMany({
      where: { userId },
    });

    // Create new pending OTP record
    await prisma.guardianOtp.create({
      data: {
        userId,
        email: normalizedEmail,
        otpHash,
        attempts: 0,
        expiresAt,
      },
    });

    // Dispatch email using guardian's dynamic SMTP credentials
    try {
      await sendGuardianOtpEmail(normalizedEmail, otp, {
        smtpUser: config.smtpUser,
        smtpAppPassword: decryptedPassword,
      });
    } catch (emailErr: any) {
      console.error('[GuardianController] Dynamic email dispatch failed:', emailErr?.message || emailErr);
      return res.status(500).json({
        success: false,
        message: emailErr?.message || 'Failed to send verification email. Please verify Gmail App Password.',
      });
    }

    return res.json({
      success: true,
      message: 'OTP sent successfully to guardian email.',
    });
  } catch (err: any) {
    console.error('[GuardianController] Error sending OTP:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * POST /api/guardian/verify-otp
 * Verifies submitted OTP code against stored hash, then saves verified guardian.
 */
export async function verifyOtp(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { email, otp, guardianName } = req.body;
    if (!email || !otp || typeof email !== 'string' || typeof otp !== 'string') {
      return res.status(400).json({ success: false, message: 'Email and OTP code are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanOtp = otp.trim();
    const cleanName = (guardianName || '').trim();

    // Retrieve pending OTP
    const pendingOtp = await prisma.guardianOtp.findFirst({
      where: { userId, email: normalizedEmail },
    });

    if (!pendingOtp) {
      return res.status(400).json({
        success: false,
        message: 'No pending OTP found for this email. Please request a new code.',
      });
    }

    // Check expiration
    if (new Date() > new Date(pendingOtp.expiresAt)) {
      await prisma.guardianOtp.delete({ where: { id: pendingOtp.id } });
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new code.',
      });
    }

    // Check maximum attempts
    if (pendingOtp.attempts >= MAX_OTP_ATTEMPTS) {
      await prisma.guardianOtp.delete({ where: { id: pendingOtp.id } });
      return res.status(400).json({
        success: false,
        message: 'Maximum verification attempts exceeded. Please request a new OTP.',
      });
    }

    // Compare hash securely
    const isValid = await bcrypt.compare(cleanOtp, pendingOtp.otpHash);

    if (!isValid) {
      const updatedAttempts = pendingOtp.attempts + 1;
      if (updatedAttempts >= MAX_OTP_ATTEMPTS) {
        await prisma.guardianOtp.delete({ where: { id: pendingOtp.id } });
        return res.status(400).json({
          success: false,
          message: 'Maximum verification attempts reached. Please request a new OTP.',
        });
      }

      await prisma.guardianOtp.update({
        where: { id: pendingOtp.id },
        data: { attempts: updatedAttempts },
      });

      const remainingAttempts = MAX_OTP_ATTEMPTS - updatedAttempts;
      return res.status(400).json({
        success: false,
        message: `Incorrect OTP. You have ${remainingAttempts} attempt(s) remaining.`,
      });
    }

    // Successful OTP verification -> upsert this guardian for the user
    const saved = await prisma.personalGuardian.upsert({
      where: { userId_guardianEmail: { userId, guardianEmail: normalizedEmail } },
      update: {
        guardianName: cleanName,
        guardianVerified: true,
        verifiedAt: new Date(),
      },
      create: {
        userId,
        guardianEmail: normalizedEmail,
        guardianName: cleanName,
        guardianVerified: true,
        verifiedAt: new Date(),
      },
    });

    // Invalidate/delete used OTP
    await prisma.guardianOtp.delete({ where: { id: pendingOtp.id } });

    return res.json({
      success: true,
      message: 'Guardian verified and saved successfully',
      guardian: {
        id: saved.id,
        guardianEmail: saved.guardianEmail,
        guardianName: saved.guardianName,
        guardianVerified: saved.guardianVerified,
        verifiedAt: saved.verifiedAt,
      },
    });
  } catch (err: any) {
    console.error('[GuardianController] Error verifying OTP:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * GET /api/guardian/status
 * Fetches all verified guardians for the user + configuration status + active pending OTP session.
 */
export async function getGuardianStatus(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const guardians = await prisma.personalGuardian.findMany({
      where: { userId },
      orderBy: { verifiedAt: 'desc' },
    });

    const configs = await prisma.guardianEmailConfig.findMany({
      where: { userId },
    });
    const configMap = new Map(configs.map((c) => [c.guardianEmail, c]));

    const pendingOtp = await prisma.guardianOtp.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    let pendingOtpData = null;
    if (pendingOtp && new Date(pendingOtp.expiresAt) > new Date()) {
      const now = Date.now();
      const expiresAtMs = new Date(pendingOtp.expiresAt).getTime();
      const createdAtMs = new Date(pendingOtp.createdAt).getTime();

      pendingOtpData = {
        email: pendingOtp.email,
        expiresInSeconds: Math.max(0, Math.floor((expiresAtMs - now) / 1000)),
        resendCooldownSeconds: Math.max(0, Math.floor((createdAtMs + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000)),
      };
    }

    return res.json({
      success: true,
      guardians: guardians.map((g) => ({
        id: g.id,
        guardianEmail: g.guardianEmail,
        guardianName: g.guardianName,
        guardianVerified: g.guardianVerified,
        configured: configMap.has(g.guardianEmail),
        verifiedAt: g.verifiedAt,
      })),
      pendingOtp: pendingOtpData,
    });
  } catch (err: any) {
    console.error('[GuardianController] Error fetching guardian status:', err);
    return res.status(500).json({ success: false, message: 'Internal server error', error: err.message, stack: err.stack });
  }
}

/**
 * DELETE /api/guardian/:id
 * Removes a specific guardian record and associated email config.
 */
export async function removeGuardian(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const rawId = req.params.id;
    if (!rawId || typeof rawId !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid guardian ID' });
    }
    const id = rawId;

    const record = await prisma.personalGuardian.findFirst({
      where: { id, userId },
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Guardian not found' });
    }

    // Delete guardian record
    await prisma.personalGuardian.delete({ where: { id } });

    // Clean up guardian email config if present
    await prisma.guardianEmailConfig.deleteMany({
      where: { userId, guardianEmail: record.guardianEmail },
    });

    return res.json({ success: true, message: 'Guardian removed successfully' });
  } catch (err: any) {
    console.error('[GuardianController] Error removing guardian:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * POST /api/guardian/navigation/security-complete
 * Sends "Passenger Security Check Update" email using guardian's dynamic SMTP credentials.
 */
export async function notifySecurityComplete(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId || 'dev_passenger_user_id';
    let verifiedGuardians = await prisma.personalGuardian.findMany({
      where: { userId, guardianVerified: true },
    });

    if (!verifiedGuardians || verifiedGuardians.length === 0) {
      verifiedGuardians = await prisma.personalGuardian.findMany({
        where: { guardianVerified: true },
      });
    }

    if (!verifiedGuardians || verifiedGuardians.length === 0) {
      return res.json({ success: true, message: 'No verified guardians found to notify.', guardianNotified: false });
    }

    let notifiedCount = 0;
    for (const g of verifiedGuardians) {
      let config = await prisma.guardianEmailConfig.findUnique({
        where: { userId_guardianEmail: { userId: g.userId, guardianEmail: g.guardianEmail } },
      });
      if (!config) {
        config = await prisma.guardianEmailConfig.findFirst({
          where: { guardianEmail: g.guardianEmail },
        });
      }

      if (config) {
        const decryptedPassword = decryptPassword(config.smtpAppPassword);
        if (decryptedPassword) {
          try {
            await sendGuardianNotificationEmail(
              g.guardianEmail,
              'Passenger Security Screening Completed 🛡️',
              `Passenger has successfully cleared the Airport Terminal Security Checkpoint and is now proceeding to Boarding Gate 14B.`,
              { smtpUser: config.smtpUser, smtpAppPassword: decryptedPassword }
            );
            notifiedCount++;
          } catch (e) {
            console.error(`[GuardianController] Failed to notify guardian ${g.guardianEmail}:`, e);
          }
        }
      }
    }

    return res.json({
      success: true,
      message: `Security check updates dispatched to ${notifiedCount} guardian(s).`,
      guardianNotified: notifiedCount > 0,
    });
  } catch (err: any) {
    console.error('[GuardianController] Error in notifySecurityComplete:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * POST /api/guardian/navigation/luggage-complete
 * Sends "Passenger Baggage Check-In Completed" email using guardian's dynamic SMTP credentials.
 */
export async function notifyLuggageComplete(req: AuthRequest, res: Response) {
  try {
    const userId = req.userId || 'dev_passenger_user_id';
    let verifiedGuardians = await prisma.personalGuardian.findMany({
      where: { userId, guardianVerified: true },
    });

    if (!verifiedGuardians || verifiedGuardians.length === 0) {
      verifiedGuardians = await prisma.personalGuardian.findMany({
        where: { guardianVerified: true },
      });
    }

    if (!verifiedGuardians || verifiedGuardians.length === 0) {
      return res.json({ success: true, message: 'No verified guardians found to notify.', guardianNotified: false });
    }

    let notifiedCount = 0;
    for (const g of verifiedGuardians) {
      let config = await prisma.guardianEmailConfig.findUnique({
        where: { userId_guardianEmail: { userId: g.userId, guardianEmail: g.guardianEmail } },
      });
      if (!config) {
        config = await prisma.guardianEmailConfig.findFirst({
          where: { guardianEmail: g.guardianEmail },
        });
      }

      if (config) {
        const decryptedPassword = decryptPassword(config.smtpAppPassword);
        if (decryptedPassword) {
          try {
            await sendGuardianNotificationEmail(
              g.guardianEmail,
              'Passenger Baggage Check-In Completed 🧳',
              `Passenger has successfully completed baggage check-in. Checked luggage has been tagged and dispatched to the aircraft.`,
              { smtpUser: config.smtpUser, smtpAppPassword: decryptedPassword }
            );
            notifiedCount++;
          } catch (e) {
            console.error(`[GuardianController] Failed to notify guardian ${g.guardianEmail}:`, e);
          }
        }
      }
    }

    return res.json({
      success: true,
      message: `Luggage updates dispatched to ${notifiedCount} guardian(s).`,
      guardianNotified: notifiedCount > 0,
    });
  } catch (err: any) {
    console.error('[GuardianController] Error in notifyLuggageComplete:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
