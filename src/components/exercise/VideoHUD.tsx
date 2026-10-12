"use client";
import React from "react";
import { ExerciseMetrics } from "@/types/exercise";

interface VideoHUDProps {
  metrics: ExerciseMetrics;
  videoElement?: React.ReactNode;
}

export function VideoHUD({ metrics, videoElement }: VideoHUDProps) {
  const { isCompensating, compensationWarningMessage, holdProgressPercent, exerciseState } = metrics;

  return (
    <div className="relative w-full aspect-[4/3] max-w-3xl rounded-3xl overflow-hidden bg-slate-950 border-4 border-slate-800 shadow-2xl transition-all">
      <div className="absolute inset-0 flex items-center justify-center">
        {videoElement ? (
          videoElement
        ) : (
          <div className="text-slate-600 font-mono text-sm tracking-wider uppercase flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-slate-700 animate-spin" />
            Camera Stream Standby
          </div>
        )}
      </div>

      {(exerciseState === "IDLE" || exerciseState === "CALIBRATING") && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-48 h-64 rounded-[50%] border-2 border-dashed border-sky-400/60 bg-sky-500/5 animate-pulse" />
          <span className="absolute top-[28%] text-xs font-semibold tracking-widest text-sky-400/80 uppercase">
            Fit Head Inside
          </span>
        </div>
      )}

      {isCompensating && (
        <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none transition-all duration-200">
          <div className="bg-amber-500/90 backdrop-blur-md text-slate-950 font-bold px-4 py-1.5 rounded-full shadow-lg text-xs sm:text-sm flex items-center gap-2 border border-amber-300/40">
            <span>⚠️</span>
            <span>{compensationWarningMessage || "Keep shoulders relaxed"}</span>
          </div>
        </div>
      )}

      {exerciseState === "HOLDING" && (
        <div className="absolute bottom-0 left-0 right-0 h-4 bg-slate-900/80">
          <div
            className="h-full bg-emerald-500 transition-all duration-100 ease-linear shadow-[0_0_12px_rgba(16,185,129,0.7)]"
            style={{ width: `${holdProgressPercent}%` }}
          />
        </div>
      )}
    </div>
  );
}