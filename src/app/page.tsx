"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { PoseLandmarker, FilesetResolver, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { createClient } from "@/lib/supabaseClient";
import AuthModal from "@/components/exercise/auth/AuthModal";
import { Volume2, Mic, ShieldCheck, UserCircle } from "lucide-react";

type ExerciseType = 
  | "ISO_FLEXION" 
  | "ISO_EXTENSION" 
  | "ISO_LATERAL_RIGHT" 
  | "ISO_LATERAL_LEFT"
  | "ROM_FLEXION"
  | "ROM_ROTATION_RIGHT"
  | "ROM_ROTATION_LEFT"
  | "ROM_SIDE_BEND_RIGHT"
  | "ROM_SIDE_BEND_LEFT"
  | "SHOULDER_SHRUG";

type AppState = "CALIBRATING" | "NEUTRAL" | "HOLDING" | "RETURNING" | "RESTING" | "EXERCISE_COMPLETE" | "SUMMARY";

interface ExerciseConfig {
  id: ExerciseType;
  name: string;
  category: "ISOMETRIC" | "ROM_POSTURE";
  shortName: string;
  instructions: string;
  illustration: string;
  imageSrc: string;
  isIsometric: boolean;
  targetAngle?: number;
  targetLandmarks?: (lm: NormalizedLandmark[]) => { x: number; y: number };
  targetHoldTime: number;
  targetReps: number;
  restTime: number;
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

const exercises: Record<ExerciseType, ExerciseConfig> = {
  ISO_FLEXION: {
    id: "ISO_FLEXION", name: "Isometric Cervical Flexion", shortName: "Flexion Press", category: "ISOMETRIC",
    instructions: "Place palm on forehead. Press head forward into palm.", illustration: "🖐️ ➔ 👤 Forehead Press",
    imageSrc: "/exercises/iso_flexion.jpg",
    isIsometric: true, targetLandmarks: (lm) => lm[0],
    targetHoldTime: 10, targetReps: 3, restTime: 5
  },
  ISO_EXTENSION: {
    id: "ISO_EXTENSION", name: "Isometric Cervical Extension", shortName: "Extension Press", category: "ISOMETRIC",
    instructions: "Place hands behind head. Push head back into hands.", illustration: "👤 ➔ 🖐️ Occiput Press",
    imageSrc: "/exercises/iso_extension.jpg",
    isIsometric: true, targetLandmarks: (lm) => ({ x: (lm[7].x + lm[8].x) / 2, y: (lm[7].y + lm[8].y) / 2 }),
    targetHoldTime: 10, targetReps: 3, restTime: 5
  },
  ISO_LATERAL_RIGHT: {
    id: "ISO_LATERAL_RIGHT", name: "Isometric Right Bending", shortName: "Right Side Press", category: "ISOMETRIC",
    instructions: "Place right palm on right temple. Press head right.", illustration: "👤 ➔ 🖐️ Right Temple Press",
    imageSrc: "/exercises/iso_lateral_right.jpg",
    isIsometric: true, targetLandmarks: (lm) => lm[8],
    targetHoldTime: 10, targetReps: 3, restTime: 5
  },
  ISO_LATERAL_LEFT: {
    id: "ISO_LATERAL_LEFT", name: "Isometric Left Bending", shortName: "Left Side Press", category: "ISOMETRIC",
    instructions: "Place left palm on left temple. Press head left.", illustration: "🖐️ ➔ 👤 Left Temple Press",
    imageSrc: "/exercises/iso_lateral_left.jpg",
    isIsometric: true, targetLandmarks: (lm) => lm[7],
    targetHoldTime: 10, targetReps: 3, restTime: 5
  },
  ROM_FLEXION: {
    id: "ROM_FLEXION", name: "Cervical Flexion (ROM)", shortName: "Chin to Chest", category: "ROM_POSTURE",
    instructions: "Lower your chin slowly toward your chest.", illustration: "👤 ➔ ⬇️ Chin to Chest",
    imageSrc: "/exercises/rom_flexion.jpg",
    isIsometric: false, targetAngle: 30,
    targetHoldTime: 15, targetReps: 3, restTime: 5
  },
  ROM_ROTATION_RIGHT: {
    id: "ROM_ROTATION_RIGHT", name: "Cervical Rotation Right (ROM)", shortName: "Look Right", category: "ROM_POSTURE",
    instructions: "Turn your head to look over your right shoulder.", illustration: "👤 ➔ ↪️ Look Right",
    imageSrc: "/exercises/rom_rotation_right.jpg",
    isIsometric: false, targetAngle: 35,
    targetHoldTime: 15, targetReps: 3, restTime: 5
  },
  ROM_ROTATION_LEFT: {
    id: "ROM_ROTATION_LEFT", name: "Cervical Rotation Left (ROM)", shortName: "Look Left", category: "ROM_POSTURE",
    instructions: "Turn your head to look over your left shoulder.", illustration: "👤 ➔ ↩️ Look Left",
    imageSrc: "/exercises/rom_rotation_left.jpg",
    isIsometric: false, targetAngle: 35,
    targetHoldTime: 15, targetReps: 3, restTime: 5
  },
  ROM_SIDE_BEND_RIGHT: {
    id: "ROM_SIDE_BEND_RIGHT", name: "Active Side Bend (Right)", shortName: "Side Bend (R)", category: "ROM_POSTURE",
    instructions: "Gently tilt your right ear down toward your right shoulder.", illustration: "👤 ➔ ↘️ Side Bend (Right)",
    imageSrc: "/exercises/rom_side_bend_right.jpg",
    isIsometric: false, targetAngle: 18,
    targetHoldTime: 15, targetReps: 3, restTime: 5
  },
  ROM_SIDE_BEND_LEFT: {
    id: "ROM_SIDE_BEND_LEFT", name: "Active Side Bend (Left)", shortName: "Side Bend (L)", category: "ROM_POSTURE",
    instructions: "Gently tilt your left ear down toward your left shoulder.", illustration: "👤 ➔ ↙️ Side Bend (Left)",
    imageSrc: "/exercises/rom_side_bend_left.jpg",
    isIsometric: false, targetAngle: 18,
    targetHoldTime: 15, targetReps: 3, restTime: 5
  },
  SHOULDER_SHRUG: {
    id: "SHOULDER_SHRUG", name: "Active Shoulder Shrugs", shortName: "Shoulder Shrug", category: "ROM_POSTURE",
    instructions: "Shrug your shoulders up toward your ears as high as you can.", illustration: "⬆️👥 Upward Shoulder Shrug",
    imageSrc: "/exercises/shoulder_shrug.jpg",
    isIsometric: false, targetAngle: 12,
    targetHoldTime: 2, targetReps: 10, restTime: 2
  },
};

const isoExerciseKeys: ExerciseType[] = [
  "ISO_FLEXION", "ISO_EXTENSION", "ISO_LATERAL_RIGHT", "ISO_LATERAL_LEFT"
];

const romExerciseKeys: ExerciseType[] = [
  "ROM_FLEXION", "ROM_ROTATION_RIGHT", "ROM_ROTATION_LEFT", "ROM_SIDE_BEND_RIGHT", "ROM_SIDE_BEND_LEFT", "SHOULDER_SHRUG"
];

const exerciseOrder: ExerciseType[] = [...isoExerciseKeys, ...romExerciseKeys];

const initReports = (): Record<ExerciseType, ExerciseReport> => ({
  ISO_FLEXION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ISO_EXTENSION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ISO_LATERAL_RIGHT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ISO_LATERAL_LEFT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ROM_FLEXION: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ROM_ROTATION_RIGHT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ROM_ROTATION_LEFT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ROM_SIDE_BEND_RIGHT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  ROM_SIDE_BEND_LEFT: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
  SHOULDER_SHRUG: { repsCompleted: 0, compensationsCount: 0, holdTimeSeconds: 0 },
});

export default function PoseCamera() {
  const canvasRef = useRef<HTMLCanvasElement>(null); 
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameId = useRef<number | null>(null);

  const [currentExerciseIndex, setCurrentExerciseIndex] = useState(0);
  const currentExercise = exerciseOrder[currentExerciseIndex];

  const [appState, setAppState] = useState<AppState>("CALIBRATING");
  const [handContactDetected, setHandContactDetected] = useState(false);
  const [currentTilt, setCurrentTilt] = useState(0);
  const [isCompensating, setIsCompensating] = useState(false);
  
  const [repCount, setRepCount] = useState(0);
  const repCountRef = useRef(0);
  useEffect(() => { repCountRef.current = repCount; }, [repCount]);
  
  const [holdTimer, setHoldTimer] = useState(exercises[currentExercise].targetHoldTime);
  const [restTimer, setRestTimer] = useState(exercises[currentExercise].restTime);
  
  const [calibrationCountdown, setCalibrationCountdown] = useState(3);
  const [earlyReleaseWarning, setEarlyReleaseWarning] = useState(false);

  const [sessionReports, setSessionReports] = useState<Record<ExerciseType, ExerciseReport>>(initReports());

  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const supabase = createClient();

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

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
      const englishVoice = voices.find((v) => v.lang.startsWith("en") && !v.name.includes("whisper"));
      if (englishVoice) utterance.voice = englishVoice;
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn("Speech synthesis error:", e);
    }
  }, []);

  useEffect(() => {
    async function checkSession() {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user?.email) setCurrentUser(data.session.user.email);
    }
    checkSession();
  }, [supabase]);

  const baselineShoulderDiffRef = useRef<number>(0);
  const baselineTiltRef = useRef<number>(0);
  const prevLandmarksRef = useRef<NormalizedLandmark[] | null>(null);
  const stateRef = useRef<AppState>("CALIBRATING");
  const currentExRef = useRef<ExerciseType>("ISO_FLEXION");
  const lastSoundAlertRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    currentExRef.current = currentExercise;
  }, [currentExercise]);

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
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
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

  const drawSkeleton = (
    ctx: CanvasRenderingContext2D, width: number, height: number, lm: NormalizedLandmark[], 
    currentAngle: number, isContacting: boolean, targetPoint: { x: number; y: number }, isIsometric: boolean
  ) => {
    ctx.clearRect(0, 0, width, height);
    const toCanvas = (pt: { x: number; y: number }) => ({ x: (1 - pt.x) * width, y: pt.y * height });

    const leftShoulder = toCanvas(lm[11]);
    const rightShoulder = toCanvas(lm[12]);
    const leftEar = toCanvas(lm[7]);
    const rightEar = toCanvas(lm[8]);
    const nose = toCanvas(lm[0]);
    const leftWrist = toCanvas(lm[15]);
    const rightWrist = toCanvas(lm[16]);
    const target = toCanvas(targetPoint);

    ctx.strokeStyle = "rgba(56, 189, 248, 0.75)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(leftShoulder.x, leftShoulder.y);
    ctx.lineTo(rightShoulder.x, rightShoulder.y);
    ctx.stroke();

    const neckBase = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
    const headMid = { x: (leftEar.x + rightEar.x) / 2, y: (leftEar.y + rightEar.y) / 2 };

    ctx.strokeStyle = isContacting ? "rgba(52, 211, 153, 0.9)" : "rgba(96, 165, 250, 0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(neckBase.x, neckBase.y);
    ctx.lineTo(headMid.x, headMid.y);
    ctx.stroke();

    if (isIsometric) {
      ctx.strokeStyle = isContacting ? "rgba(16, 185, 129, 0.9)" : "rgba(244, 63, 94, 0.7)";
      ctx.fillStyle = isContacting ? "rgba(16, 185, 129, 0.25)" : "rgba(244, 63, 94, 0.15)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(target.x, target.y, width * 0.12, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fill();
    }

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

    if (!isIsometric) {
      ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
      ctx.beginPath();
      ctx.roundRect(headMid.x - 28, headMid.y - 36, 56, 24, 6);
      ctx.fill();
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${currentAngle}°`, headMid.x, headMid.y - 20);
    }
  };

  const processFrame = useCallback(() => {
    if (landmarkerRef.current && videoRef.current && videoRef.current.readyState >= 2) {
      const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());

      if (results.landmarks && results.landmarks[0]) {
        const rawLm = results.landmarks[0];
        const lm = rawLm.map((pt, idx) => smoothLandmark(prevLandmarksRef.current ? prevLandmarksRef.current[idx] : null, pt));
        prevLandmarksRef.current = lm;

        const leftEar = lm[7];
        const rightEar = lm[8];
        const leftShoulder = lm[11];
        const rightShoulder = lm[12];
        const nose = lm[0];
        const leftWrist = lm[15];
        const rightWrist = lm[16];

        const midEar = { x: (leftEar.x + rightEar.x) / 2, y: (leftEar.y + rightEar.y) / 2 };
        const midShoulder = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };

        const activeEx = exercises[currentExRef.current];
        let rawMeasurement = 0;

        switch (activeEx.id) {
          case "ROM_FLEXION":
            rawMeasurement = (midShoulder.y - nose.y) * 100;
            break;
          case "ROM_ROTATION_RIGHT":
          case "ROM_ROTATION_LEFT":
            const earDist = Math.abs(rightEar.x - leftEar.x) || 1;
            rawMeasurement = ((nose.x - midEar.x) / earDist) * 100;
            break;
          case "ROM_SIDE_BEND_RIGHT":
          case "ROM_SIDE_BEND_LEFT": {
            const dy = rightEar.y - leftEar.y;
            const dx = (leftEar.x - rightEar.x) || 0.001;
            rawMeasurement = Math.atan2(dy, dx) * (180 / Math.PI);
            break;
          }
          case "SHOULDER_SHRUG":
            rawMeasurement = ((leftShoulder.y + rightShoulder.y) / 2);
            break;
          default:
            rawMeasurement = 0;
            break;
        }

        const currentState = stateRef.current;
        const now = Date.now();

        if (currentState === "CALIBRATING") {
          baselineShoulderDiffRef.current = Math.abs(leftShoulder.y - rightShoulder.y);
          baselineTiltRef.current = rawMeasurement; 
        }

        let calculatedAngle = 0;

        switch (activeEx.id) {
          case "ROM_FLEXION":
            calculatedAngle = (baselineTiltRef.current - rawMeasurement) * 3;
            break;
          case "ROM_ROTATION_RIGHT":
          case "ROM_ROTATION_LEFT":
            calculatedAngle = Math.abs(rawMeasurement - baselineTiltRef.current) * 1.5;
            break;
          case "ROM_SIDE_BEND_RIGHT":
            calculatedAngle = (rawMeasurement - baselineTiltRef.current) * 1.5;
            break;
          case "ROM_SIDE_BEND_LEFT":
            calculatedAngle = (baselineTiltRef.current - rawMeasurement) * 1.5;
            break;
          case "SHOULDER_SHRUG":
            calculatedAngle = (baselineTiltRef.current - rawMeasurement) * 100;
            break;
          default:
            calculatedAngle = 0;
            break;
        }

        const absTilt = Math.max(0, Math.round(calculatedAngle));
        setCurrentTilt(absTilt <= 2 ? 0 : absTilt); 

        let isContacting = false;
        let targetPt = { x: nose.x, y: nose.y };

        if (activeEx.isIsometric && activeEx.targetLandmarks) {
          targetPt = activeEx.targetLandmarks(lm);
          const distLeftHand = Math.hypot(leftWrist.x - targetPt.x, leftWrist.y - targetPt.y);
          const distRightHand = Math.hypot(rightWrist.x - targetPt.x, rightWrist.y - targetPt.y);
          isContacting = distLeftHand < 0.20 || distRightHand < 0.20;
        } else {
          isContacting = absTilt >= (activeEx.targetAngle || 18);
        }

        setHandContactDetected(isContacting);

        if (canvasRef.current) {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            drawSkeleton(ctx, canvas.width, canvas.height, lm, absTilt <= 2 ? 0 : absTilt, isContacting, targetPt, activeEx.isIsometric);
          }
        }

        const currentShoulderYDiff = Math.abs(leftShoulder.y - rightShoulder.y);
        const isCurrentlyCompensating = activeEx.id !== "SHOULDER_SHRUG" && (currentShoulderYDiff - baselineShoulderDiffRef.current > 0.075);
        setIsCompensating(isCurrentlyCompensating);

        if (currentState !== "EXERCISE_COMPLETE" && currentState !== "SUMMARY" && isCurrentlyCompensating) {
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

        if (currentState !== "EXERCISE_COMPLETE" && currentState !== "SUMMARY" && currentState !== "RESTING") {
          if (isContacting && currentState === "NEUTRAL") {
            playTone(587.33, "sine", 0.1);
            speakFeedback(activeEx.isIsometric ? `Hold pressure for ${activeEx.targetHoldTime} seconds. Keep steady.` : `Target reached. Hold steady for ${activeEx.targetHoldTime} seconds.`);
            setAppState("HOLDING");
          } else if (!isContacting && currentState === "HOLDING") {
            playTone(220, "sawtooth", 0.25);
            speakFeedback(activeEx.isIsometric ? `Contact lost. Hold the full ${activeEx.targetHoldTime} seconds without releasing.` : `Position lost. Hold the full ${activeEx.targetHoldTime} seconds.`);
            setHoldTimer(activeEx.targetHoldTime);
            setAppState("NEUTRAL");
            setEarlyReleaseWarning(true);
            setTimeout(() => setEarlyReleaseWarning(false), 3000);

            setSessionReports((prev) => ({
              ...prev,
              [currentExRef.current]: {
                ...prev[currentExRef.current],
                compensationsCount: prev[currentExRef.current].compensationsCount + 1,
              },
            }));
          } else if (!isContacting && currentState === "RETURNING") {
            speakFeedback(`Good. Now rest for ${activeEx.restTime} seconds.`);
            setRestTimer(activeEx.restTime);
            setAppState("RESTING");
          }
        }
      }
    }

    animFrameId.current = requestAnimationFrame(processFrame);
  }, [speakFeedback]);

  useEffect(() => {
    animFrameId.current = requestAnimationFrame(processFrame);
    return () => {
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
    };
  }, [processFrame]);

  useEffect(() => {
    if (appState === "CALIBRATING") {
      const timer = setInterval(() => {
        setCalibrationCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setAppState("NEUTRAL");
            speakFeedback(exercises[currentExercise].isIsometric ? "Ready. Place your hand as shown to begin." : "Ready. Move to the target position.");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [speakFeedback, currentExercise, appState]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (appState === "HOLDING" && holdTimer > 0) {
      interval = setInterval(() => setHoldTimer((prev) => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [appState, holdTimer]);

  useEffect(() => {
    if (appState === "HOLDING" && holdTimer === 0) {
      playTone(880, "triangle", 0.25);
      const newRep = repCountRef.current + 1; 
      const activeEx = exercises[currentExercise];
      
      setRepCount(newRep);
      setSessionReports((prev) => ({
        ...prev,
        [currentExercise]: {
          ...prev[currentExercise],
          repsCompleted: newRep,
          holdTimeSeconds: prev[currentExercise].holdTimeSeconds + activeEx.targetHoldTime,
        },
      }));

      if (newRep >= activeEx.targetReps) {
        speakFeedback("Set complete! Great work.");
        setAppState("EXERCISE_COMPLETE");
      } else {
        speakFeedback(activeEx.isIsometric ? "Hold complete. Release your hands." : "Hold complete. Return to neutral.");
        setAppState("RETURNING"); 
      }
    }
  }, [appState, holdTimer, currentExercise, speakFeedback]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (appState === "RESTING" && restTimer > 0) {
      interval = setInterval(() => setRestTimer((prev) => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [appState, restTimer]);

  useEffect(() => {
    if (appState === "RESTING" && restTimer === 0) {
      speakFeedback("Rest complete. Move into position for the next rep.");
      setHoldTimer(exercises[currentExercise].targetHoldTime);
      setAppState("NEUTRAL");
    }
  }, [appState, restTimer, speakFeedback, currentExercise]);

  const selectExercise = (key: ExerciseType) => {
    const targetIdx = exerciseOrder.indexOf(key);
    if (targetIdx !== -1) {
      setCurrentExerciseIndex(targetIdx);
      setAppState("CALIBRATING");
      setCalibrationCountdown(3);
      setRepCount(0);
      setHoldTimer(exercises[key].targetHoldTime);
      setRestTimer(exercises[key].restTime);
      speakFeedback(`Selected ${exercises[key].name}`);
    }
  };

  const startNextExercise = () => {
    if (currentExerciseIndex < exerciseOrder.length - 1) {
      const nextKey = exerciseOrder[currentExerciseIndex + 1];
      setCurrentExerciseIndex((prev) => prev + 1);
      setAppState("CALIBRATING");
      setCalibrationCountdown(3);
      setRepCount(0);
      setHoldTimer(exercises[nextKey].targetHoldTime);
      setRestTimer(exercises[nextKey].restTime);
      speakFeedback(`Starting ${exercises[nextKey].name}`);
    } else {
      setAppState("SUMMARY");
      speakFeedback("Routine finished. Here is your final report.");
    }
  };

  const calculateOverallReport = () => {
    let totalReps = 0;
    let totalExpectedReps = 0;
    let totalCompensations = 0;
    const problemsIdentified: string[] = [];

    exerciseOrder.forEach((exKey) => {
      const report = sessionReports[exKey];
      const exConfig = exercises[exKey];
      if (!report || !exConfig) return;

      totalReps += report.repsCompleted;
      totalExpectedReps += exConfig.targetReps;
      totalCompensations += report.compensationsCount;

      if (report.repsCompleted < exConfig.targetReps) {
        problemsIdentified.push(`Incomplete reps for ${exConfig.name} (${report.repsCompleted}/${exConfig.targetReps}).`);
      }
      if (report.compensationsCount > 3) {
        problemsIdentified.push(`Shoulder hiking observed during ${exConfig.name}. Relax trapezius.`);
      }
    });

    if (totalCompensations === 0 && totalReps === totalExpectedReps) {
      problemsIdentified.push("Flawless form. Excellent postural stabilization across all planes.");
    }

    const overallScore = Math.max(100 - totalCompensations * 2 - (totalExpectedReps - totalReps) * 3, 50);
    return { totalReps, totalExpectedReps, totalCompensations, overallScore, problemsIdentified };
  };

  const overall = calculateOverallReport();

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
      speakFeedback("Session saved successfully.");
    } catch (err: unknown) {
      console.error("Save error:", err);
      setSaveStatus("Failed to save session. Make sure you run the SQL table script.");
      speakFeedback("Failed to save session.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="h-screen w-screen overflow-hidden bg-[#070B14] text-slate-100 flex flex-col justify-between p-3 select-none">
      
      {/* ================= HEADER BAR ================= */}
      <header className="flex items-center justify-between bg-slate-900/60 backdrop-blur-xl border border-slate-800 px-4 py-2 rounded-2xl shadow-xl shrink-0">
        <div className="flex items-center space-x-3">
          <div className="h-3 w-3 rounded-full bg-cyan-400 animate-pulse shadow-lg shadow-cyan-500/50" />
          <h1 className="text-sm font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
            PhysioTrack <span className="text-cyan-400 font-light">Rehab AI</span>
          </h1>
        </div>

        <div className="flex items-center space-x-3">
          <button 
            onClick={() => {
              const nextState = !voiceEnabled;
              setVoiceEnabled(nextState);
              if (nextState) speakFeedback("Voice coach enabled.");
            }}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-xl text-xs font-semibold transition border ${
              voiceEnabled ? "bg-blue-600/30 border-blue-500 text-cyan-300" : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {voiceEnabled ? <Volume2 size={14} /> : <Mic size={14} />}
            <span>Voice: {voiceEnabled ? "ON" : "OFF"}</span>
          </button>
          
          {currentUser ? (
            <span className="text-xs font-medium text-slate-300 bg-slate-800 px-3 py-1 rounded-xl border border-slate-700">👤 {currentUser}</span>
          ) : (
            <button onClick={() => setShowAuthModal(true)} className="flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 px-3 py-1 rounded-xl text-xs font-medium transition">
              <UserCircle size={15} className="text-cyan-400" />
              <span>Sign In / Register</span>
            </button>
          )}
        </div>
      </header>

      {showAuthModal && <AuthModal onSuccess={(email) => setCurrentUser(email)} onClose={() => setShowAuthModal(false)} />}

      {/* ================= ORIGINAL UPPER SELECTOR ROWS ================= */}
      <section className="flex flex-col space-y-1.5 shrink-0 my-1">
        {/* Isometric Row */}
        <div className="bg-slate-900/40 border border-slate-800/80 px-3 py-1.5 rounded-xl flex items-center space-x-3 shadow-md">
          <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 pl-1 shrink-0 w-24">
            Isometric (4)
          </span>
          <div className="grid grid-cols-4 gap-2 flex-1">
            {isoExerciseKeys.map((exKey) => {
              const ex = exercises[exKey];
              const isActive = currentExercise === exKey;
              return (
                <button
                  key={exKey}
                  onClick={() => selectExercise(exKey)}
                  className={`py-1 px-2 rounded-lg text-xs font-semibold transition shadow-sm ${
                    isActive
                      ? "bg-blue-600 text-white shadow-blue-900/50 shadow-md ring-1 ring-blue-400"
                      : "bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/50"
                  }`}
                >
                  {ex.shortName}
                </button>
              );
            })}
          </div>
        </div>

        {/* Active ROM Row */}
        <div className="bg-slate-900/40 border border-slate-800/80 px-3 py-1.5 rounded-xl flex items-center space-x-3 shadow-md">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 pl-1 shrink-0 w-24">
            Active ROM (6)
          </span>
          <div className="grid grid-cols-6 gap-2 flex-1">
            {romExerciseKeys.map((exKey) => {
              const ex = exercises[exKey];
              const isActive = currentExercise === exKey;
              return (
                <button
                  key={exKey}
                  onClick={() => selectExercise(exKey)}
                  className={`py-1 px-1 rounded-lg text-xs font-semibold transition shadow-sm truncate ${
                    isActive
                      ? "bg-emerald-600 text-white shadow-emerald-900/50 shadow-md ring-1 ring-emerald-400"
                      : "bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/50"
                  }`}
                >
                  {ex.shortName}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ================= COMPACT TELEMETRY HUD ================= */}
      <section className="grid grid-cols-3 gap-3 shrink-0 my-1">
        <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800/80 px-4 py-2 rounded-2xl flex items-center justify-between shadow-lg">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Target Action</span>
            <div className="text-xs font-extrabold text-cyan-400 mt-0.5">
              {appState === "CALIBRATING" && `Calibrating (${calibrationCountdown}s)`}
              {appState === "NEUTRAL" && (handContactDetected ? "Hold Position!" : exercises[currentExercise].instructions)}
              {appState === "HOLDING" && `Holding Steady (${holdTimer}s)`}
              {appState === "RESTING" && `Rest Break (${restTimer}s)`}
              {appState === "EXERCISE_COMPLETE" && "Set Complete!"}
            </div>
          </div>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800/80 px-4 py-2 rounded-2xl flex items-center justify-between shadow-lg">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Live Progress</span>
            <div className="text-sm font-black text-amber-400 mt-0.5">
              {exercises[currentExercise].isIsometric ? (handContactDetected ? "🟢 Contact Active" : "🔴 Waiting for Hand") : `${currentTilt}° ROM`}
            </div>
          </div>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800/80 px-4 py-2 rounded-2xl flex items-center justify-between shadow-lg">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Repetitions</span>
            <div className="text-sm font-black text-white mt-0.5">{repCount} / {exercises[currentExercise].targetReps}</div>
          </div>
          <button onClick={() => setAppState("EXERCISE_COMPLETE")} className="text-[10px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1 rounded-xl transition">
            Skip ➔
          </button>
        </div>
      </section>

      {/* ================= FULL-SCREEN SPLIT VIEWPORT ================= */}
      <section className="grid grid-cols-2 gap-3 flex-1 min-h-0 mb-1">
        
        {/* Left Card: Full-Fill Form Reference */}
        <div className="bg-slate-900/60 backdrop-blur-2xl rounded-3xl p-3 border border-slate-800/80 shadow-2xl flex flex-col justify-between overflow-hidden relative">
          <div className="absolute top-4 left-4 bg-slate-950/80 backdrop-blur-md text-cyan-400 text-[10px] font-extrabold px-3 py-1.5 rounded-xl border border-slate-800 z-10 shadow-lg">
            📖 Target Form Reference
          </div>
          
          <div className="flex-1 flex items-center justify-center my-auto overflow-hidden relative rounded-2xl bg-slate-950/40 border border-slate-800/50">
            <img
              src={exercises[currentExercise].imageSrc}
              alt={exercises[currentExercise].name}
              className="w-full h-full object-contain p-2 rounded-2xl"
              onError={(e) => { (e.target as HTMLElement).style.display = "none"; }}
            />
          </div>
        </div>

        {/* Right Card: Full-Screen AI Camera Feed */}
        <div className="bg-slate-950 rounded-3xl p-3 border border-slate-800/80 shadow-2xl flex flex-col justify-between overflow-hidden relative">
          <div className="absolute top-4 left-4 bg-blue-600/90 backdrop-blur-md text-white text-[10px] font-extrabold px-3 py-1.5 rounded-xl shadow-lg z-20 flex items-center space-x-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
            <span>Live AI Vision (30 FPS)</span>
          </div>

          {isCompensating && (
            <div className="absolute top-4 right-4 bg-amber-500/90 text-white text-[10px] font-bold py-1.5 px-3 rounded-full backdrop-blur shadow animate-bounce z-30">
              ⚠️ Form Warning: Keep Shoulders Level
            </div>
          )}

          {earlyReleaseWarning && (
            <div className="absolute top-14 right-4 bg-red-600/95 text-white text-[10px] font-bold py-1.5 px-3 rounded-full backdrop-blur shadow animate-bounce z-30">
              ⚠️ Position Lost: Rep Cancelled
            </div>
          )}

          <div className="flex-1 flex flex-col items-center justify-center relative rounded-2xl overflow-hidden shadow-inner bg-black">
            <video ref={videoRef} className="absolute inset-0 w-full h-full -scale-x-100 object-cover opacity-90" playsInline muted />
            <canvas ref={canvasRef} width={640} height={480} className="absolute inset-0 w-full h-full pointer-events-none z-10" />

            {appState === "CALIBRATING" && (
              <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl flex flex-col items-center justify-center text-white p-6 text-center z-30">
                <h3 className="text-xl font-black mb-1">Align & Calibrate</h3>
                <p className="text-slate-400 text-xs mb-3">Sit upright facing the camera...</p>
                <div className="text-5xl font-black text-cyan-400 animate-pulse">{calibrationCountdown}</div>
              </div>
            )}

            {appState === "EXERCISE_COMPLETE" && (
              <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center text-white p-6 text-center z-40">
                <h3 className="text-2xl font-black text-emerald-400 mb-1">Set Complete! 🎉</h3>
                <button onClick={startNextExercise} className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-2xl shadow-xl text-xs transition mt-3">
                  Next Exercise ➔
                </button>
              </div>
            )}

            {appState === "SUMMARY" && (
              <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-3xl flex flex-col items-center justify-center text-white p-6 text-center z-50 overflow-y-auto">
                <h2 className="text-2xl font-black text-emerald-400 mb-2">Session Report Card</h2>
                <div className="text-4xl font-extrabold text-cyan-400 mb-4">{overall.overallScore}% Score</div>
                
                <div className="w-full max-w-md bg-slate-900/90 rounded-2xl p-4 border border-slate-800 text-xs mb-4 text-left">
                  <div className="font-bold text-amber-400 mb-1">Clinical Observations:</div>
                  <ul className="list-disc list-inside text-slate-300 space-y-1">
                    {overall.problemsIdentified.map((prob, i) => (
                      <li key={i}>{prob}</li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-2 w-full max-w-xs mb-4">
                  <button
                    onClick={async () => {
                      setIsSaving(true);
                      try {
                        const { data } = await supabase.auth.getSession();
                        await supabase.from("rehab_sessions").insert([{
                          user_id: data?.session?.user?.id || null,
                          user_email: data?.session?.user?.email || "guest",
                          overall_score: overall.overallScore,
                          total_reps: overall.totalReps,
                          total_compensations: overall.totalCompensations,
                          session_breakdown: sessionReports,
                          clinical_notes: overall.problemsIdentified,
                        }]);
                        setSaveStatus("Saved to patient record! ✅");
                        speakFeedback("Session saved successfully.");
                      } catch {
                        setSaveStatus("Save failed.");
                      } finally {
                        setIsSaving(false);
                      }
                    }}
                    disabled={isSaving}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-6 rounded-xl text-xs transition"
                  >
                    {isSaving ? "Saving..." : "💾 Save to Patient Record"}
                  </button>
                  {saveStatus && <span className="text-xs text-emerald-300">{saveStatus}</span>}
                </div>

                <button onClick={() => window.location.reload()} className="bg-blue-600 text-white font-bold py-2.5 px-6 rounded-2xl text-xs">Restart Routine 🔄</button>
              </div>
            )}
          </div>

          <div className="bg-slate-900/80 backdrop-blur-md border border-slate-800/80 py-2 px-4 rounded-xl flex items-center justify-between text-xs text-slate-400 shrink-0 mt-2">
            <div className="flex items-center space-x-2">
              <ShieldCheck size={14} className="text-emerald-400" />
              <span className="text-[11px]">MediaPipe WASM Engine Active (18ms)</span>
            </div>
            <span className="text-cyan-400 font-mono font-bold text-[11px]">Status: READY</span>
          </div>
        </div>

      </section>

    </main>
  );
}