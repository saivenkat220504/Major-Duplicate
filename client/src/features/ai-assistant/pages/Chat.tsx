import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { ArrowLeft, Send, Check, Loader, ChevronDown, Info, User, Star } from 'lucide-react';

interface Message {
  sender: 'user' | 'staff' | 'system';
  text: string;
  timestamp: Date;
}

const OPTIONS = [
  { value: '1', label: 'I missed my connecting flight', solution: 'If you have missed your connecting flight, visit the nearest Transfer Service Desk located in the transit area. Airport staff there can verify your booking, retrieve baggage information, arrange rebooking (subject to airline policy), and guide you to your new boarding gate.' },
  { value: '2', label: 'My baggage is delayed or missing', solution: 'Proceed to the Lost & Found / Baggage Service Counter near the baggage claim area. Keep your baggage tag and boarding pass ready. Staff will register your complaint and provide baggage tracking updates.' },
  { value: '3', label: 'I lost my passport or ID', solution: 'Immediately report the incident to the Airport Police Help Desk or Customer Service Counter. They will guide you through documentation, identity verification, and contact your embassy if necessary.' },
  { value: '4', label: 'I need wheelchair or special assistance', solution: 'Visit the nearest Customer Service Desk. Airport staff will arrange wheelchair support or mobility assistance and coordinate with your airline if required.' },
  { value: '5', label: 'I cannot find my boarding gate', solution: 'Check the Flight Information Display Screens (FIDS) located throughout the terminal. If you\'re still unable to locate your gate, approach the nearest Information Counter for directions.' },
  { value: '6', label: 'Flight delay or cancellation inquiry', solution: 'Visit your airline\'s service counter. Airline representatives can provide delay updates, meal vouchers (if applicable), accommodation details, or rebooking options depending on airline policy.' },
  { value: '7', label: 'Immigration or visa related assistance', solution: 'Please visit the Immigration Help Desk located before passport control. Officers will assist you regarding visa issues, immigration procedures, and travel documentation requirements.' },
  { value: '8', label: 'I lost a personal belonging inside the airport', solution: 'Visit the Airport Lost & Found Office as soon as possible. Provide a detailed description of the missing item, approximate location, and time it was last seen.' },
  { value: '9', label: 'Other Reason', solution: '' }
];

export default function ChatPage() {
  const navigate = useNavigate();

  // Steps: 'dropdown' | 'solution' | 'loading' | 'staff-card' | 'chat' | 'resolved'
  const [step, setStep] = useState<'dropdown' | 'solution' | 'loading' | 'staff-card' | 'chat' | 'resolved'>('dropdown');
  const [selectedReason, setSelectedReason] = useState('');
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [feedback, setFeedback] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<any>(null);

  // Auto-scroll chat history
  useEffect(() => {
    if (step === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, step]);

  // Loading animation duration (2.5 seconds)
  useEffect(() => {
    if (step === 'loading') {
      const timer = setTimeout(() => {
        setStep('staff-card');
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [step]);

  // Connect to Socket.IO backend when entering 'chat' step
  useEffect(() => {
    if (step !== 'chat') return;

    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
    const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
    const socket = io(socketUrl);
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('support-reply', (data: { sender: 'staff', text: string, timestamp: string }) => {
      setChatHistory(prev => [
        ...prev,
        {
          sender: 'staff',
          text: data.text,
          timestamp: new Date(data.timestamp)
        }
      ]);
    });

    return () => {
      socket.disconnect();
    };
  }, [step]);

  const handleReasonChange = (val: string) => {
    if (!val) return;
    setSelectedReason(val);
    if (val === '9') {
      setStep('loading');
    } else {
      setStep('solution');
    }
  };

  const handleConnectNow = () => {
    setChatHistory([]);
    setStep('chat');
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const messageText = inputText.trim();
    setInputText('');
    setIsSending(true);
    setErrorMsg('');

    // Append user message immediately to the feed
    const userMessage: Message = {
      sender: 'user',
      text: messageText,
      timestamp: new Date()
    };
    setChatHistory(prev => [...prev, userMessage]);

    try {
      const res = await fetch('/api/support/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: messageText })
      });

      if (!res.ok) {
        throw new Error('Server returned an error status.');
      }
    } catch (err) {
      console.error('Failed to send support message:', err);
      // Append an error/system message to the history
      setChatHistory(prev => [
        ...prev,
        {
          sender: 'system',
          text: 'Unable to send message. Please try again.',
          timestamp: new Date()
        }
      ]);
      setErrorMsg('Unable to send message. Please try again.');
    } finally {
      setIsSending(false);
    }
  };

  const handleReset = () => {
    setSelectedReason('');
    setChatHistory([]);
    setInputText('');
    setRating(0);
    setFeedback('');
    setStep('dropdown');
  };

  const selectedOption = OPTIONS.find(o => o.value === selectedReason);

  return (
    <div className="max-w-2xl mx-auto py-4 px-2">
      {/* Back Button / Navigation bar */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => {
            if (step === 'dropdown') navigate('/');
            else if (step === 'solution') handleReset();
            else if (step === 'loading') handleReset();
            else if (step === 'staff-card') handleReset();
            else if (step === 'chat') {
              if (window.confirm("End active Customer Support session?")) {
                setStep('resolved');
              }
            } else if (step === 'resolved') {
              handleReset();
            }
          }}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors py-1 px-3 rounded-lg hover:bg-slate-100 font-medium"
        >
          <ArrowLeft size={16} />
          {step === 'dropdown' ? 'Home' : 'Back'}
        </button>
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest bg-slate-100 px-3 py-1 rounded-full">
          Customer Support Portal
        </span>
      </div>

      {/* STEP 1: DROPDOWN SELECTION */}
      {step === 'dropdown' && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8 transition-all duration-300 animate-fadeIn">
          <div className="text-center mb-6">
            <div className="inline-flex p-3 bg-sky-50 rounded-2xl text-sky-600 mb-3 animate-pulse">
              <Info size={32} />
            </div>
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Need Assistance?</h2>
            <p className="text-slate-500 mt-2 text-base md:px-8">
              Select the reason why you want to contact customer care. We may already have an instant solution for your issue.
            </p>
          </div>

          <div className="flex flex-col gap-2 mb-6">
            <label
              htmlFor="customer-support-reason-select"
              className="text-sm font-bold text-slate-700 dark:text-slate-300"
            >
              Select reason why you want to contact customer care
              <span className="text-red-500 ml-1">*</span>
            </label>

            <div className="relative">
              <select
                id="customer-support-reason-select"
                value={selectedReason}
                onChange={(e) => handleReasonChange(e.target.value)}
                className="w-full appearance-none bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border-2 border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3.5 pr-10 text-sm font-medium focus:outline-none focus:border-sky-500 dark:focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 transition-all cursor-pointer"
              >
                <option value="">Select a reason</option>
                {OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <ChevronDown size={18} className="text-slate-400" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: SELF-HELP SOLUTION CARD */}
      {step === 'solution' && selectedOption && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8 animate-fadeIn max-w-xl mx-auto flex flex-col gap-6">
          <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
            <div className="p-3 bg-sky-50 text-sky-600 rounded-2xl">
              <Info size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-slate-900">Suggested Solution</h3>
              <p className="text-xs text-slate-500">Based on your selected issue</p>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-5">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Your Issue</div>
            <p className="text-slate-800 font-semibold text-lg mb-4">
              {selectedOption.label}
            </p>
            
            <div className="text-xs font-bold text-sky-600 uppercase tracking-wider mb-2">Suggested Solution</div>
            <p className="text-slate-700 text-base leading-relaxed font-normal whitespace-pre-line">
              {selectedOption.solution}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={handleReset}
              className="py-4 px-6 rounded-2xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-all text-center"
            >
              Back to reasons
            </button>
            <button
              onClick={() => setStep('loading')}
              className="py-4 px-6 rounded-2xl font-bold text-white bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 transition-all shadow-md flex items-center justify-center gap-2"
            >
              Still Need Help?
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: LOADING SCREEN */}
      {step === 'loading' && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-8 text-center min-h-[350px] flex flex-col items-center justify-center animate-fadeIn">
          <div className="relative w-32 h-32 mb-8">
            <div className="absolute inset-0 rounded-full border-4 border-sky-100 animate-ping opacity-75"></div>
            <div className="absolute inset-2 rounded-full border-4 border-sky-200 animate-pulse"></div>
            <div className="absolute inset-4 rounded-full border-2 border-indigo-300"></div>
            
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-500 text-white flex items-center justify-center shadow-lg">
                <Loader size={32} className="animate-spin text-white" />
              </div>
            </div>
          </div>

          <h3 className="text-2xl font-extrabold text-slate-900 tracking-tight animate-pulse">
            Searching for Available Customer Support Executive...
          </h3>
          <p className="text-slate-500 mt-2 max-w-sm mx-auto text-base">
            Connecting you to our airport passenger services team. Please wait...
          </p>
        </div>
      )}

      {/* STEP 4: STAFF ASSIGNMENT CARD */}
      {step === 'staff-card' && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8 animate-fadeIn max-w-md mx-auto flex flex-col gap-6">
          <div className="text-center pb-2 border-b border-slate-100">
            <span className="text-xs font-bold text-sky-600 uppercase tracking-widest bg-sky-50 px-3 py-1 rounded-full">
              Customer Support Executive
            </span>
          </div>

          <div className="flex flex-col items-center gap-4">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-sky-50 dark:bg-sky-950 flex items-center justify-center border-4 border-sky-100 dark:border-sky-900 shadow-md text-sky-600 dark:text-sky-400">
                <User size={48} />
              </div>
              <span className="absolute bottom-1 right-1 block h-4 w-4 rounded-full bg-emerald-500 border-2 border-white animate-pulse"></span>
            </div>

            <div className="text-center">
              <h3 className="text-2xl font-extrabold text-slate-900">👤 Priya Sharma</h3>
              <p className="text-sm text-slate-500 font-medium">Senior Customer Support Officer</p>
            </div>
          </div>

          <div className="bg-slate-50 rounded-2xl p-5 space-y-3 text-sm border border-slate-100">
            <div className="flex justify-between items-center">
              <span className="text-slate-400 font-medium">Employee ID</span>
              <span className="text-slate-900 font-bold font-mono">EMP-2045</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 font-medium">Designation</span>
              <span className="text-slate-900 font-semibold text-right">Senior Customer Support Officer</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 font-medium">Department</span>
              <span className="text-slate-900 font-semibold text-right">Airport Passenger Services</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 font-medium">Languages Spoken</span>
              <span className="text-slate-900 font-semibold text-right">English, Hindi, Telugu</span>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-slate-100">
              <span className="text-slate-400 font-medium">Availability Status</span>
              <span className="inline-flex items-center gap-1.5 text-emerald-600 font-bold">
                <span className="h-2.5 w-2.5 bg-emerald-500 rounded-full animate-pulse"></span>
                Available Now
              </span>
            </div>
          </div>

          <button
            onClick={handleConnectNow}
            className="w-full py-4 px-6 rounded-2xl bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-bold text-lg shadow-lg shadow-sky-200 transition-all flex items-center justify-center gap-2 hover:scale-[1.01]"
          >
            Connect Now
          </button>
        </div>
      )}

      {/* STEP 5: SIMULATED LIVE CHAT */}
      {step === 'chat' && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 flex flex-col h-[550px] overflow-hidden animate-fadeIn">
          {/* Active Chat Header */}
          <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white p-4 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-12 h-12 rounded-full bg-indigo-900/80 flex items-center justify-center border-2 border-indigo-400 text-indigo-200">
                  <User size={24} />
                </div>
                <span className="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full bg-emerald-500 border-2 border-slate-950 animate-pulse"></span>
              </div>
              <div>
                <div className="font-extrabold text-sm tracking-tight">Customer Support Chat</div>
                <div className="text-xs text-indigo-300 font-medium">Officer: Priya Sharma • Online</div>
              </div>
            </div>
            
            <button
              onClick={() => {
                if (window.confirm("End your live session with Customer Support?")) {
                  setStep('resolved');
                }
              }}
              className="bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white transition-all text-xs font-bold py-2 px-4 rounded-xl border border-red-500/20"
            >
              End Support Session
            </button>
          </div>

          {/* Messages Flow Area */}
          <div className="flex-1 bg-slate-50 p-4 overflow-y-auto space-y-4 flex flex-col">
            <div className="text-center py-2">
              <span className="text-[10px] font-bold text-slate-400 bg-slate-200/60 px-3 py-1 rounded-full uppercase tracking-wider">
                Simulated Secure Connection Established
              </span>
            </div>

            {chatHistory.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 my-auto">
                <div className="w-16 h-16 bg-sky-50 text-sky-600 rounded-full flex items-center justify-center mb-4 shadow-sm border border-sky-100 animate-bounce">
                  <Send size={28} className="transform rotate-45 -translate-x-1 translate-y-0.5" />
                </div>
                <h3 className="text-xl font-bold text-slate-800">Welcome to Airport Customer Support</h3>
                <p className="text-slate-500 mt-2 text-sm max-w-xs">
                  How can we help you today?
                </p>
              </div>
            ) : (
              chatHistory.map((msg, idx) => {
                if (msg.sender === 'system') {
                  return (
                    <div key={idx} className="flex justify-center animate-fadeIn">
                      <span className="text-xs font-semibold text-red-500 bg-red-50 px-3 py-1 rounded-full border border-red-100">
                        {msg.text}
                      </span>
                    </div>
                  );
                }

                const isStaff = msg.sender === 'staff';
                return (
                  <div
                    key={idx}
                    className={`flex ${isStaff ? 'justify-start' : 'justify-end'} animate-fadeIn`}
                  >
                    <div className="flex items-end gap-2 max-w-[85%]">
                      <div
                        className={`p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm font-normal ${
                          isStaff
                            ? 'bg-white text-slate-800 rounded-bl-none border border-slate-100'
                            : 'bg-indigo-600 text-white rounded-br-none'
                        }`}
                      >
                        <p className="font-semibold text-xs mb-1 text-slate-400">
                          {isStaff ? 'Support' : 'You'}
                        </p>
                        <p>{msg.text}</p>
                        <span
                          className={`block text-[10px] mt-1 text-right ${
                            isStaff ? 'text-slate-400' : 'text-indigo-200'
                          }`}
                        >
                          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}

          {isSending && (
            <div className="flex justify-end items-center gap-2 animate-pulse">
              <div className="bg-indigo-600/60 rounded-2xl rounded-br-none p-3.5 flex items-center gap-1.5 shadow-sm text-indigo-100">
                <Loader size={14} className="animate-spin" />
                <span className="text-xs">Sending...</span>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Support Chat Input form */}
        <form onSubmit={handleSendMessage} className="bg-white p-3 border-t border-slate-100 flex flex-col gap-2">
          {errorMsg && (
            <div className="text-xs text-red-500 font-semibold px-2">
              ⚠️ {errorMsg}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type your message..."
              className="flex-1 bg-black text-white placeholder-slate-500 border-2 border-slate-900 rounded-2xl px-4 py-3 focus:outline-none focus:border-sky-500 transition-colors text-sm"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isSending}
              className={`p-3 rounded-2xl transition-all shadow-md flex items-center justify-center ${
                inputText.trim() && !isSending
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500 hover:scale-105'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
              }`}
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      </div>
    )}

      {/* STEP 6: SUCCESS RESOLVED SCREEN */}
      {step === 'resolved' && (
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8 text-center animate-scaleUp">
          <div className="w-20 h-20 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm border border-emerald-100">
            <Check size={36} className="text-emerald-500" strokeWidth={3} />
          </div>

          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Support Service Completed</h2>
          <p className="text-slate-500 mt-2 text-base md:px-8">
            Thank you for using Customer Support. We hope we resolved your issue effectively.
          </p>

          <div className="my-8 max-w-sm mx-auto bg-slate-50 rounded-2xl p-5 border border-slate-100">
            <h4 className="text-sm font-bold text-slate-700 mb-3">Rate your support interaction</h4>
            
            {/* Interactive Stars */}
            <div className="flex justify-center gap-2 mb-4">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setRating(star)}
                  onMouseEnter={() => setHoverRating(star)}
                  onMouseLeave={() => setHoverRating(0)}
                  className="transition-transform duration-100 hover:scale-125"
                >
                  <Star
                    className={`w-8 h-8 ${
                      star <= (hoverRating || rating) ? 'text-amber-400 fill-amber-400' : 'text-slate-300'
                    }`}
                  />
                </button>
              ))}
            </div>

            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Additional feedback (optional)..."
              rows={2}
              className="w-full text-slate-800 placeholder-slate-400 border border-slate-200 rounded-xl p-3 focus:outline-none focus:border-indigo-500 transition-colors text-sm resize-none"
            />
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleReset}
              className="py-3 px-6 rounded-xl font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all text-sm"
            >
              Start New Request
            </button>
            <button
              onClick={() => navigate('/')}
              className="py-3 px-6 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-all text-sm"
            >
              Return to Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
