"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { PoseLandmarker, FilesetResolver, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { createClient } from "@/lib/supabaseClient";
import AuthModal from "@/components/exercise/auth/AuthModal";

type ExerciseType = "FLEXION" | "EXTENSION" | "LATERAL_RIGHT" | "LATERAL_LEFT";
type AppState = "CALIBRATING" | "NEUTRAL" | "HOLDING" | "RETURNING" | "EXERCISE_COMPLETE" | "SUMMARY";

interface ExerciseConfig {
  id: ExerciseType;
  name: string;
  instructions: string;
  illustration: string;
  targetLandmarks: (lm: NormalizedLandmark[]) => { x: number; y: number };
}

interface ExerciseReport {
  repsCompleted: number;
  compensationsCount: number;
  holdTimeSeconds: number;
}

function smoothLandmark(prev: NormalizedLandmark | null, curr: NormalizedLandmark, alpha = 0.4): NormalizedLandmark {
  if (!prev) return curr;
  return {
    x: prev.x + alpha * (curr.x - prev.x),
    y: prev.y + alpha * (curr.y - prev.y),
    z: prev.z + alpha * (curr.z - prev.z),
    visibility: curr.visibility,
  };
}

function playTone(freq: number, type: OscillatorType = "sine", duration = 0.15) {
  try {
    const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch {
    // Audio autostart fallback
  }
}

function speakFeedback(text: string) {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel(); // Interrupt previous cue so it doesn't queue up
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  }
}

const exercises: Record<ExerciseType, ExerciseConfig> = {
  FLEXION: {
    id: "FLEXION",
    name: "Isometric Cervical Flexion",
    instructions: "Place palm on forehead. Press head forward into palm while resisting movement.",
    illustration: "🖐️ ➔ 👤 Forehead Press",
    targetLandmarks: (lm) => lm[0],
  },
  EXTENSION: {
    id: "EXTENSION",
    name: "Isometric Cervical Extension",
    instructions: "Place hands behind head. Push head back into hands while resisting movement.",
    illustration: "👤 ➔ 🖐️ Occiput Press",
    targetLandmarks: (lm) => ({ x: (lm[7].x + lm[8].x) / 2, y: (lm[7].y + lm[8].y) / 2 }),
  },
  LATERAL_RIGHT: {
    id: "LATERAL_RIGHT",
    name: "Isometric Right Bending",
    instructions: "Place right palm on right temple. Press head right while resisting movement.",
    illustration: "👤 ➔ 🖐️ Right Temple Press",
    targetLandmarks: (lm) => lm[8],
  },
  LATERAL_LEFT: {
    id: "LATERAL_LEFT",
    name: "Isometric Left Bending",
    instructions: "Place left palm on left temple. Press head left while resisting movement.",
    illustration: "🖐️ ➔ 👤 Left Temple Press",
    targetLandmarks: (lm) => lm[7],
  },
};

export default function PoseCamera() {
  const canvasRef = useRef<HTMLCanvasElement>(null); 
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameId = useRef<number | null>(null);

  const exerciseOrder: ExerciseType[] = ["FLEXION", "EXTENSION", "LATERAL_RIGHT", "LATERAL_LEFT"];
  const [currentExerciseIndex, setCurrentExerciseIndex] = useState(0);
  const currentExercise = exerciseOrder[currentExerciseIndex];

  const [appState, setAppState] = useState<AppState>("CALIBRATING");
  const [handContactDetected, setHandContactDetected] = useState(false);
  const [currentTilt, setCurrentTilt] = useState(0);
  const [isCompensating, setIsCompensating] = useState(false);
  const [repCount, setRepCount] = useState(0);
  const [holdTimer, setHoldTimer] = useState(3);
  const [calibrationCountdown, setCalibrationCountdown] = useState(3);

  const [sessionReports, setSessionReports] = useState<Record<ExerciseType, ExerciseReport>>({
    FLEXION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
    EXTENSION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
    LATERAL_RIGHT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
    LATERAL_LEFT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  });

  // Auth & Cloud Persistence
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const supabase = createClient();

  // Voice Coach State & Ref
  // Voice Coach State & Ref
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  // Pre-warm browser speech synthesis voices
  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  const speakFeedback = useCallback((text: string) => {
    if (!voiceEnabledRef.current || typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    try {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const englishVoice = voices.find(
        (v) => v.lang.startsWith("en") && !v.name.includes("whisper")
      );
      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn("Speech synthesis error:", e);
    }
  }, []);

  useEffect(() => {
    async function checkSession() {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user?.email) {
        setCurrentUser(data.session.user.email);
      }
    }
    checkSession();
  }, [supabase]);

  const baselineShoulderDiffRef = useRef<number>(0);
  const baselineTiltRef = useRef<number>(0);
  const prevLandmarksRef = useRef<NormalizedLandmark[] | null>(null);
  const stateRef = useRef<AppState>("CALIBRATING");
  const currentExRef = useRef<ExerciseType>("FLEXION");
  const isCooldownRef = useRef<boolean>(false);
  const lastSoundAlertRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    currentExRef.current = currentExercise;
  }, [currentExercise]);

  // MediaPipe Setup
  useEffect(() => {
    let mounted = true;
    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        if (!mounted) return;

        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });

        if (!mounted) return;
        landmarkerRef.current = landmarker;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, frameRate: { ideal: 30 } },
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err) {
        console.error("Camera/MediaPipe initialization failed:", err);
      }
    }

    initMediaPipe();

    return () => {
      mounted = false;
      if (landmarkerRef.current) landmarkerRef.current.close();
    };
  }, []);

  // Draw skeleton lines, vectors, and angle arcs
  const drawSkeleton = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    lm: NormalizedLandmark[],
    currentAngle: number,
    isContacting: boolean,
    targetPoint: { x: number; y: number }
  ) => {
    ctx.clearRect(0, 0, width, height);

    // MediaPipe normalized coordinates (0 to 1) -> Canvas pixels
    // Since video has -scale-x-100, we map x directly to match mirrored CSS
    const toCanvas = (pt: { x: number; y: number }) => ({
      x: (1 - pt.x) * width, // mirror X coordinate
      y: pt.y * height,
    });

    const leftShoulder = toCanvas(lm[11]);
    const rightShoulder = toCanvas(lm[12]);
    const leftEar = toCanvas(lm[7]);
    const rightEar = toCanvas(lm[8]);
    const nose = toCanvas(lm[0]);
    const leftWrist = toCanvas(lm[15]);
    const rightWrist = toCanvas(lm[16]);
    const target = toCanvas(targetPoint);

    // 1. Draw Shoulder Baseline Vector
    ctx.strokeStyle = "rgba(56, 189, 248, 0.75)"; // Cyan
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(leftShoulder.x, leftShoulder.y);
    ctx.lineTo(rightShoulder.x, rightShoulder.y);
    ctx.stroke();

    // 2. Draw Cervical Spine Vector (Neck base to head midpoint)
    const neckBase = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2,
    };
    const headMid = {
      x: (leftEar.x + rightEar.x) / 2,
      y: (leftEar.y + rightEar.y) / 2,
    };

    ctx.strokeStyle = isContacting ? "rgba(52, 211, 153, 0.9)" : "rgba(96, 165, 250, 0.9)"; // Green if contact, blue otherwise
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(neckBase.x, neckBase.y);
    ctx.lineTo(headMid.x, headMid.y);
    ctx.stroke();

    // 3. Draw Target Contact Zone
    ctx.strokeStyle = isContacting ? "rgba(16, 185, 129, 0.9)" : "rgba(244, 63, 94, 0.7)";
    ctx.fillStyle = isContacting ? "rgba(16, 185, 129, 0.25)" : "rgba(244, 63, 94, 0.15)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(target.x, target.y, width * 0.12, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fill();

    // 4. Draw Key Landmark Joints
    const joints = [leftShoulder, rightShoulder, leftEar, rightEar, nose, leftWrist, rightWrist];
    joints.forEach((joint) => {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(joint.x, joint.y, 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = "#0284c7";
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // 5. Draw Angle Badge above Head
    ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
    ctx.beginPath();
    ctx.roundRect(headMid.x - 28, headMid.y - 36, 56, 24, 6);
    ctx.fill();

    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${currentAngle}°`, headMid.x, headMid.y - 20);
  };

  // Frame processing loop
  const processFrame = useCallback(() => {
    if (landmarkerRef.current && videoRef.current && videoRef.current.readyState >= 2) {
      const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());

      if (results.landmarks && results.landmarks[0]) {
        const rawLm = results.landmarks[0];
        const lm = rawLm.map((pt, idx) =>
          smoothLandmark(prevLandmarksRef.current ? prevLandmarksRef.current[idx] : null, pt)
        );
        prevLandmarksRef.current = lm;

        const leftEar = lm[7];
        const rightEar = lm[8];
        const leftShoulder = lm[11];
        const rightShoulder = lm[12];
        const leftWrist = lm[15];
        const rightWrist = lm[16];

        // Symmetrical Relative Angle Calculation
        const headMidX = (leftEar.x + rightEar.x) / 2;
        const headMidY = (leftEar.y + rightEar.y) / 2;
        const neckBaseX = (leftShoulder.x + rightShoulder.x) / 2;
        const neckBaseY = (leftShoulder.y + rightShoulder.y) / 2;

        const dxCervical = headMidX - neckBaseX;
        const dyCervical = neckBaseY - headMidY;
        const headTiltRad = Math.atan2(dxCervical, dyCervical);

        const dxShoulder = rightShoulder.x - leftShoulder.x;
        const dyShoulder = rightShoulder.y - leftShoulder.y;
        const shoulderTiltRad = Math.atan2(dyShoulder, dxShoulder);

        let relativeAngleDeg = (headTiltRad - shoulderTiltRad) * (180 / Math.PI);
        relativeAngleDeg = ((relativeAngleDeg + 180) % 360 + 360) % 360 - 180;
        relativeAngleDeg -= baselineTiltRef.current;
        relativeAngleDeg = ((relativeAngleDeg + 180) % 360 + 360) % 360 - 180;

        const absTilt = Math.abs(Math.round(relativeAngleDeg));
        setCurrentTilt(absTilt <= 2 ? 0 : absTilt);

        // Contact verification
        const activeEx = exercises[currentExRef.current];
        const targetPt = activeEx.targetLandmarks(lm);
        const distLeftHand = Math.hypot(leftWrist.x - targetPt.x, leftWrist.y - targetPt.y);
        const distRightHand = Math.hypot(rightWrist.x - targetPt.x, rightWrist.y - targetPt.y);
        const isContacting = distLeftHand < 0.20 || distRightHand < 0.20;
        setHandContactDetected(isContacting);

        // Render Canvas Skeleton & Overlay
        if (canvasRef.current) {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            drawSkeleton(
              ctx,
              canvas.width,
              canvas.height,
              lm,
              absTilt <= 2 ? 0 : absTilt,
              isContacting,
              targetPt
            );
          }
        }

        // Shoulder compensation with alert throttling
        const currentShoulderYDiff = Math.abs(leftShoulder.y - rightShoulder.y);
        const isCurrentlyCompensating =
          currentShoulderYDiff - baselineShoulderDiffRef.current > 0.075;
        setIsCompensating(isCurrentlyCompensating);

        const currentState = stateRef.current;
        const now = Date.now();

        if (currentState === "CALIBRATING") {
          baselineShoulderDiffRef.current = currentShoulderYDiff;
          baselineTiltRef.current = relativeAngleDeg;
        } else if (
          currentState !== "EXERCISE_COMPLETE" &&
          currentState !== "SUMMARY" &&
          isCurrentlyCompensating
        ) {
          if (now - lastSoundAlertRef.current > 2000) {
            playTone(330, "sawtooth", 0.2);
            speakFeedback("Keep your shoulders relaxed and level.");
            lastSoundAlertRef.current = now;
            setSessionReports((prev) => ({
              ...prev,
              [currentExRef.current]: {
                ...prev[currentExRef.current],
                compensationsCount: prev[currentExRef.current].compensationsCount + 1,
              },
            }));
          }
        }

        // State Machine transitions
        if (!isCooldownRef.current && currentState !== "EXERCISE_COMPLETE" && currentState !== "SUMMARY") {
          if (isContacting && currentState === "NEUTRAL") {
            playTone(587.33, "sine", 0.1);
            speakFeedback("Hold pressure. Keep steady.");
            setAppState("HOLDING");
          } else if (!isContacting && currentState === "RETURNING") {
            isCooldownRef.current = true;
            playTone(880, "triangle", 0.25);

            setRepCount((prevRep) => {
              const newRep = prevRep + 1;
              setSessionReports((prev) => ({
                ...prev,
                [currentExRef.current]: {
                  ...prev[currentExRef.current],
                  repsCompleted: newRep,
                  holdTimeSeconds: prev[currentExRef.current].holdTimeSeconds + 3,
                },
              }));

              if (newRep >= 5) {
                speakFeedback("Set complete. Great work!");
                setAppState("EXERCISE_COMPLETE");
              }else {
                speakFeedback(`Rep ${newRep} complete.`); 
              }
              return newRep;
            });

            if (stateRef.current !== "EXERCISE_COMPLETE") {
              setAppState("NEUTRAL");
            }

            setTimeout(() => {
              isCooldownRef.current = false;
            }, 1200);
          }
        }
      }
    }

    animFrameId.current = requestAnimationFrame(processFrame);
  }, []);

  useEffect(() => {
    animFrameId.current = requestAnimationFrame(processFrame);
    return () => {
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
    };
  }, [processFrame]);

  // Timers
  useEffect(() => {
    if (appState === "CALIBRATING") {
      const timer = setInterval(() => {
        setCalibrationCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setAppState("NEUTRAL");
            speakFeedback("Ready. Place your hand as shown to begin.");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [appState]);

  useEffect(() => {
    let holdInterval: NodeJS.Timeout;
    if (appState === "HOLDING") {
      holdInterval = setInterval(() => {
        setHoldTimer((prev) => {
          if (prev <= 1) {
            clearInterval(holdInterval);
            setAppState("RETURNING");
            return 3;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setHoldTimer(3);
    }
    return () => clearInterval(holdInterval);
  }, [appState]);

  const startNextExercise = () => {
    if (currentExerciseIndex < exerciseOrder.length - 1) {
      setCurrentExerciseIndex((prev) => prev + 1);
      setAppState("CALIBRATING");
      setCalibrationCountdown(3);
      setRepCount(0);
    } else {
      setAppState("SUMMARY");
    }
  };

  const calculateOverallReport = () => {
    let totalReps = 0;
    let totalCompensations = 0;
    const problemsIdentified: string[] = [];

    Object.keys(sessionReports).forEach((key) => {
      const exKey = key as ExerciseType;
      const report = sessionReports[exKey];
      totalReps += report.repsCompleted;
      totalCompensations += report.compensationsCount;

      if (report.repsCompleted < 5) {
        problemsIdentified.push(`Incomplete reps for ${exercises[exKey].name} (${report.repsCompleted}/5).`);
      }
      if (report.compensationsCount > 3) {
        problemsIdentified.push(`Shoulder hiking observed during ${exercises[exKey].name}. Relax trapezius.`);
      }
    });

    if (totalCompensations === 0 && totalReps === 20) {
      problemsIdentified.push("Flawless form. Excellent postural stabilization across all planes.");
    }

    const overallScore = Math.max(100 - totalCompensations * 4 - (20 - totalReps) * 3, 50);
    return { totalReps, totalCompensations, overallScore, problemsIdentified };
  };

  const overall = calculateOverallReport();

  // Save report to Supabase rehab_sessions table
  const saveSessionToCloud = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData?.session?.user;

      const payload = {
        user_id: user?.id || null,
        user_email: user?.email || "guest",
        overall_score: overall.overallScore,
        total_reps: overall.totalReps,
        total_compensations: overall.totalCompensations,
        session_breakdown: sessionReports,
        clinical_notes: overall.problemsIdentified,
      };

      const { error } = await supabase.from("rehab_sessions").insert([payload]);
      if (error) throw error;
      setSaveStatus("Session saved to your patient record! ✅");
    } catch (err: unknown) {
      console.error("Save error:", err);
      setSaveStatus("Failed to save session. Make sure you run the SQL table script.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-6 max-w-5xl mx-auto font-sans text-slate-800">
      
      {/* Navigation & Patient Account Bar */}
      <div className="w-full flex justify-between items-center mb-2 px-2">
        <div className="text-xs font-bold text-slate-500">
          PhysioTrack <span className="text-blue-600">Rehab AI</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Voice Coach Toggle Button */}
          <button
            onClick={() => {
              const nextState = !voiceEnabled;
              setVoiceEnabled(nextState);
              if (nextState) {
                speakFeedback("Voice coach enabled.");
              }
            }}
            className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-3 py-1.5 rounded-xl border border-slate-200 transition cursor-pointer"
          >
            {voiceEnabled ? "🔊 Voice: ON" : "🔇 Voice: OFF"}
          </button>

          {currentUser ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
                👤 {currentUser}
              </span>
              <button
                onClick={async () => {
                  await supabase.auth.signOut();
                  setCurrentUser(null);
                }}
                className="text-xs text-red-500 hover:underline font-medium"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAuthModal(true)}
              className="text-xs bg-slate-900 hover:bg-slate-800 text-white font-bold px-3.5 py-1.5 rounded-xl transition shadow"
            >
              Sign In / Register
            </button>
          )}
        </div>
      </div>

      {showAuthModal && (
        <AuthModal
          onSuccess={(email) => setCurrentUser(email)}
          onClose={() => setShowAuthModal(false)}
        />
      )}

      {/* Exercise Selection Tabs */}
      <div className="flex flex-wrap gap-2 justify-center w-full">
        {exerciseOrder.map((exKey, idx) => (
          <button
            key={exKey}
            onClick={() => {
              setCurrentExerciseIndex(idx);
              setAppState("CALIBRATING");
              setCalibrationCountdown(3);
              setRepCount(0);
            }}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm ${
              currentExercise === exKey
                ? "bg-blue-600 text-white shadow-blue-200 shadow-lg scale-105"
                : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
            }`}
          >
            {exercises[exKey].name}
          </button>
        ))}
      </div>

      {/* Telemetry Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full">
        <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100 text-center flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Exercise Guide</div>
          <div className="text-lg font-bold my-1 text-slate-700">{exercises[currentExercise].illustration}</div>
          <p className="text-xs text-slate-600 font-medium">{exercises[currentExercise].instructions}</p>
        </div>

        <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100 text-center flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Target Action</div>
          <div className="text-lg font-extrabold text-blue-600 mt-1">
            {appState === "CALIBRATING" && `Calibrating (${calibrationCountdown}s)`}
            {appState === "NEUTRAL" && (handContactDetected ? "Hold Pressure!" : "Place Hand on Head")}
            {appState === "HOLDING" && `Hold Pressure! (${holdTimer}s)`}
            {appState === "RETURNING" && "Release Hand Pressure"}
            {appState === "EXERCISE_COMPLETE" && "Set Complete!"}
            {appState === "SUMMARY" && "Session Complete!"}
          </div>
        </div>

        <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100 text-center flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Current Tilt</div>
          <div className="text-3xl font-black text-slate-800 my-1">{currentTilt}°</div>
          <span className="text-[11px] text-slate-500">Shoulders Centered</span>
        </div>

        <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100 text-center flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Progress</div>
          <div className="text-3xl font-black text-slate-800 my-1">{repCount} / 5</div>
          <button
            onClick={() => setAppState("EXERCISE_COMPLETE")}
            className="mt-1 text-[11px] bg-slate-800 hover:bg-slate-900 text-white font-bold py-1 px-3 rounded-lg shadow transition"
          >
            {currentExerciseIndex < exerciseOrder.length - 1 ? "Skip ➔" : "Report 📊"}
          </button>
        </div>
      </div>

      {/* Video Viewport Container */}
      <div className="relative border-4 border-slate-200/80 rounded-3xl overflow-hidden bg-slate-900 shadow-2xl">
        <video
          ref={videoRef}
          className="w-[640px] h-[480px] -scale-x-100 object-cover"
          playsInline
          muted
        />

        <canvas
          ref={canvasRef}
          width={640}
          height={480}
          className="absolute inset-0 pointer-events-none z-10"
        />

        {/* Hand Contact Badge */}
        <div className="absolute top-4 left-4">
          <span
            className={`px-3 py-1.5 rounded-full text-xs font-extrabold shadow-lg backdrop-blur ${
              handContactDetected
                ? "bg-emerald-500/90 text-white animate-pulse"
                : "bg-slate-800/80 text-slate-300"
            }`}
          >
            {handContactDetected ? "🟢 Hand Contact Detected" : "⚪ Awaiting Hand Placement"}
          </span>
        </div>

        {/* Form Warning Badge */}
        {isCompensating && (
          <div className="absolute top-4 right-4 bg-amber-500/90 text-white text-xs font-bold py-1.5 px-3 rounded-full backdrop-blur shadow animate-bounce">
            ⚠️ Form Warning: Keep Shoulders Level
          </div>
        )}

        {/* Calibration Overlay */}
        {appState === "CALIBRATING" && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md flex flex-col items-center justify-center text-white p-6 text-center">
            <div className="text-xl font-bold mb-2">Sit Up Straight & Face Camera</div>
            <p className="text-slate-300 text-xs max-w-xs mb-4">
              Calibrating posture reference for {exercises[currentExercise].name}...
            </p>
            <div className="text-5xl font-black text-blue-400">{calibrationCountdown}</div>
          </div>
        )}

        {/* Exercise Completed Modal */}
        {appState === "EXERCISE_COMPLETE" && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center text-white p-8 text-center">
            <h3 className="text-2xl font-black text-emerald-400 mb-2">Set Complete! 🎉</h3>
            <p className="text-slate-300 text-sm max-w-sm mb-6">
              You completed <strong>{exercises[currentExercise].name}</strong>. Ready for the next one?
            </p>
            <button
              onClick={startNextExercise}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-xl shadow-lg text-xs"
            >
              {currentExerciseIndex < exerciseOrder.length - 1 ? "Start Next Exercise ➔" : "View Final Report Card 📊"}
            </button>
          </div>
        )}

        {/* End-of-Session Performance Summary */}
        {appState === "SUMMARY" && (
          <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-start text-white p-6 text-center overflow-y-auto">
            <h2 className="text-2xl font-black text-emerald-400 mb-1">Cervical Rehabilitation Report Card</h2>
            <div className="text-xs text-slate-400 mb-4">WHO Protocol: Isometric Cervical Stabilization</div>

            <div className="flex items-center gap-6 bg-slate-900/80 p-4 rounded-2xl border border-slate-800 mb-6">
              <div>
                <div className="text-xs text-slate-400 font-bold uppercase">Overall Performance</div>
                <div className="text-5xl font-black text-blue-400">{overall.overallScore}%</div>
              </div>
              <div className="text-left text-xs border-l border-slate-800 pl-4">
                <div>• Total Reps Completed: <strong className="text-white">{overall.totalReps} / 20</strong></div>
                <div>• Form Posture Alerts: <strong className="text-amber-400">{overall.totalCompensations}</strong></div>
              </div>
            </div>

            <div className="w-full text-xs mb-6">
              <div className="font-bold text-slate-300 text-left mb-2">Exercise Breakdown:</div>
              <div className="bg-slate-900/90 rounded-xl overflow-hidden border border-slate-800">
                <table className="w-full text-left">
                  <thead className="bg-slate-800 text-slate-400">
                    <tr>
                      <th className="p-2">Exercise</th>
                      <th className="p-2 text-center">Reps</th>
                      <th className="p-2 text-center">Hold Time</th>
                      <th className="p-2 text-center">Posture Alerts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {exerciseOrder.map((exKey) => (
                      <tr key={exKey}>
                        <td className="p-2 font-medium">{exercises[exKey].name}</td>
                        <td className="p-2 text-center font-bold">{sessionReports[exKey].repsCompleted} / 5</td>
                        <td className="p-2 text-center">{sessionReports[exKey].holdTimeSeconds}s</td>
                        <td className="p-2 text-center text-amber-400 font-bold">
                          {sessionReports[exKey].compensationsCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="w-full text-left bg-slate-900/90 p-4 rounded-xl border border-slate-800 text-xs mb-4">
              <div className="font-bold text-amber-400 mb-1">Clinical Observations:</div>
              <ul className="list-disc list-inside text-slate-300 space-y-1">
                {overall.problemsIdentified.map((prob, i) => (
                  <li key={i}>{prob}</li>
                ))}
              </ul>
            </div>

            {/* Cloud Save Action */}
            <div className="flex flex-col items-center gap-2 mb-4 w-full">
              <button
                onClick={saveSessionToCloud}
                disabled={isSaving}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-2.5 px-6 rounded-xl shadow-lg text-xs transition"
              >
                {isSaving ? "Saving to Cloud..." : "💾 Save Report to My Patient Record"}
              </button>
              {saveStatus && (
                <span className="text-xs text-emerald-300 font-medium">
                  {saveStatus}
                </span>
              )}
            </div>

            <button
              onClick={() => {
                setCurrentExerciseIndex(0);
                setAppState("CALIBRATING");
                setCalibrationCountdown(3);
                setRepCount(0);
                setSaveStatus(null);
                setSessionReports({
                  FLEXION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
                  EXTENSION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
                  LATERAL_RIGHT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
                  LATERAL_LEFT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
                });
              }}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2.5 px-6 rounded-xl shadow-lg text-xs"
            >
              Start New Full Routine 🔄
            </button>
          </div>
        )}
      </div>
    </div>
  );
}