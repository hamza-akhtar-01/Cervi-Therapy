"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export interface PoseFrameMetrics {
  currentAngle: number;
  direction: "left" | "right" | "neutral";
  isCompensating: boolean;
  leftShoulderY: number;
  rightShoulderY: number;
}

export function useMediaPipePose() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameId = useRef<number | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [cameraActive, setCameraActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calibration buffers
  const isCalibratingRef = useRef<boolean>(false);
  const calibrationSamplesRef = useRef<{ angle: number; shoulderDiff: number }[]>([]);
  const baselineTiltRef = useRef<number>(0);
  const baselineShoulderDiffRef = useRef<number>(0);

  // Smoothed angle accumulator
  const smoothedAngleRef = useRef<number>(0);

  const [poseMetrics, setPoseMetrics] = useState<PoseFrameMetrics>({
    currentAngle: 0,
    direction: "neutral",
    isCompensating: false,
    leftShoulderY: 0,
    rightShoulderY: 0,
  });

  useEffect(() => {
    let mounted = true;

    async function setupMediaPipe() {
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
        setIsLoading(false);
      } catch (err) {
        console.error("Failed to load MediaPipe:", err);
        setError("Failed to load vision model.");
        setIsLoading(false);
      }
    }

    setupMediaPipe();

    return () => {
      mounted = false;
      if (landmarkerRef.current) landmarkerRef.current.close();
    };
  }, []);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: { ideal: 30 } },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraActive(true);
      }
    } catch (err) {
      console.error("Camera access denied or failed:", err);
      setError("Please allow camera access to use the rehabilitation assistant.");
    }
  }, []);

  const processFrame = useCallback(() => {
    if (
      landmarkerRef.current &&
      videoRef.current &&
      videoRef.current.readyState >= 2
    ) {
      const startTimeMs = performance.now();
      const results = landmarkerRef.current.detectForVideo(
        videoRef.current,
        startTimeMs
      );

      if (results.landmarks && results.landmarks[0]) {
        const lm = results.landmarks[0];
        const leftEar = lm[7];
        const rightEar = lm[8];
        const leftShoulder = lm[11];
        const rightShoulder = lm[12];

        // 1. Ear vector & Shoulder vector
        const headAngleRad = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);
        const shoulderAngleRad = Math.atan2(rightShoulder.y - leftShoulder.y, rightShoulder.x - leftShoulder.x);

        // Relative angle in degrees
        let rawRelative = (headAngleRad - shoulderAngleRad) * (180 / Math.PI);
        rawRelative = ((rawRelative + 180) % 360 + 360) % 360 - 180;

        const currentShoulderDiff = Math.abs(leftShoulder.y - rightShoulder.y);

        // If calibrating, collect samples
        if (isCalibratingRef.current) {
          calibrationSamplesRef.current.push({
            angle: rawRelative,
            shoulderDiff: currentShoulderDiff,
          });
        }

        // Apply baseline offset
        let relativeAngleDeg = rawRelative - baselineTiltRef.current;
        relativeAngleDeg = ((relativeAngleDeg + 180) % 360 + 360) % 360 - 180;

        // Exponential Moving Average (EMA) to kill noise (alpha = 0.25)
        smoothedAngleRef.current =
          0.25 * relativeAngleDeg + 0.75 * smoothedAngleRef.current;

        const roundedAngle = Math.round(smoothedAngleRef.current);
        const absAngle = Math.abs(roundedAngle);

        // Deadzone: under 3 degrees is considered perfectly neutral
        const displayAngle = absAngle <= 2 ? 0 : absAngle;

        // Shoulder compensation check
        const shoulderCompensated =
          currentShoulderDiff - baselineShoulderDiffRef.current > 0.075;

        let direction: "left" | "right" | "neutral" = "neutral";
        if (roundedAngle > 3) direction = "left";
        else if (roundedAngle < -3) direction = "right";

        setPoseMetrics({
          currentAngle: displayAngle,
          direction,
          isCompensating: shoulderCompensated,
          leftShoulderY: leftShoulder.y,
          rightShoulderY: rightShoulder.y,
        });
      }
    }

    animFrameId.current = requestAnimationFrame(processFrame);
  }, []);

  useEffect(() => {
    if (cameraActive) {
      animFrameId.current = requestAnimationFrame(processFrame);
    }
    return () => {
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
    };
  }, [cameraActive, processFrame]);

  // Calibration starts collecting samples, then averages them after 2.5 seconds
  const calibrateNeutral = useCallback(() => {
    calibrationSamplesRef.current = [];
    isCalibratingRef.current = true;

    setTimeout(() => {
      isCalibratingRef.current = false;
      const samples = calibrationSamplesRef.current;
      if (samples.length > 0) {
        const avgAngle =
          samples.reduce((acc, curr) => acc + curr.angle, 0) / samples.length;
        const avgShoulderDiff =
          samples.reduce((acc, curr) => acc + curr.shoulderDiff, 0) /
          samples.length;

        baselineTiltRef.current = avgAngle;
        baselineShoulderDiffRef.current = avgShoulderDiff;
        smoothedAngleRef.current = 0;
      }
    }, 2500);
  }, []);

  return {
    videoRef,
    isLoading,
    cameraActive,
    error,
    startCamera,
    calibrateNeutral,
    poseMetrics,
  };
}