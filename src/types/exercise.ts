export type ExerciseState = 
  | 'IDLE' 
  | 'CALIBRATING' 
  | 'READY' 
  | 'HOLDING' 
  | 'RETURNING' 
  | 'COMPLETED';

export type MovementDirection = 'left' | 'right' | 'neutral';

export interface ExerciseMetrics {
  currentAngle: number;
  targetAngle: number;
  direction: MovementDirection;
  holdProgressPercent: number;
  repCount: number;
  totalTargetReps: number;
  isCompensating: boolean;
  compensationWarningMessage?: string;
  exerciseState: ExerciseState;
}