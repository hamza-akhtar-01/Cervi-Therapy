"use client";
import React from "react";
import { ExerciseMetrics } from "@/types/exercise";

interface MetricsHUDProps {
  metrics: ExerciseMetrics;
}

export function MetricsHUD({ metrics }: MetricsHUDProps) {
  const { currentAngle, targetAngle, repCount, totalTargetReps, direction, exerciseState } = metrics;

  return (
    <div className="grid grid-cols-3 gap-4 w-full max-w-3xl">
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center text-center shadow-lg">
        <span className="text-xs uppercase font-bold tracking-widest text-slate-400 mb-1">
          Current Tilt
        </span>
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-black font-mono tracking-tight text-white">
            {currentAngle}
          </span>
          <span className="text-xl font-bold text-sky-400">°</span>
        </div>
        <div className="text-xs font-medium text-slate-400 mt-2 flex items-center gap-1.5">
          <span>Target:</span>
          <span className="text-slate-200 font-bold">{targetAngle}°</span>
        </div>
      </div>

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center text-center shadow-lg">
        <span className="text-xs uppercase font-bold tracking-widest text-slate-400 mb-1">
          Reps
        </span>
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-black font-mono tracking-tight text-emerald-400">
            {repCount}
          </span>
          <span className="text-xl font-bold text-slate-500">/ {totalTargetReps}</span>
        </div>
        <span className="text-xs font-semibold text-slate-400 mt-2 capitalize">
          {direction === "neutral" ? "Neutral center" : `Tilting ${direction}`}
        </span>
      </div>

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center text-center shadow-lg">
        <span className="text-xs uppercase font-bold tracking-widest text-slate-400 mb-1">
          Status
        </span>
        <div className="mt-1">
          {exerciseState === "HOLDING" && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse">
              HOLD POSITION
            </span>
          )}
          {exerciseState === "READY" && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-black bg-sky-500/20 text-sky-300 border border-sky-500/40">
              READY
            </span>
          )}
          {exerciseState === "CALIBRATING" && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-black bg-amber-500/20 text-amber-300 border border-amber-500/40">
              CALIBRATING...
            </span>
          )}
          {exerciseState === "RETURNING" && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-black bg-purple-500/20 text-purple-300 border border-purple-500/40">
              RETURN TO CENTER
            </span>
          )}
          {exerciseState === "IDLE" && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-black bg-slate-800 text-slate-400 border border-slate-700">
              WAITING
            </span>
          )}
        </div>
        <span className="text-[11px] text-slate-500 mt-3 truncate max-w-[120px]">
          Lateral Flexion
        </span>
      </div>
    </div>
  );
}