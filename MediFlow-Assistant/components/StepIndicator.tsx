import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type Step = {
  label: string
}

type Props = {
  steps: Step[]
  currentStep: number
}

const StepIndicator = ({ steps, currentStep }: Props) => {
  return (
    <div className="flex items-center">
      {steps.map((step, index) => {
        const stepNumber = index + 1
        const isComplete = stepNumber < currentStep
        const isActive = stepNumber === currentStep
        return (
          <React.Fragment key={step.label}>
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                  isComplete && 'border-[#D90013] bg-[#D90013] text-white',
                  isActive && !isComplete && 'border-[#D90013] text-[#D90013]',
                  !isActive && !isComplete && 'border-input text-muted-foreground'
                )}
              >
                {isComplete ? <Check className="h-3.5 w-3.5" /> : stepNumber}
              </div>
              <span
                className={cn(
                  'text-[11px] whitespace-nowrap',
                  isActive || isComplete ? 'text-foreground font-medium' : 'text-muted-foreground'
                )}
              >
                {step.label}
              </span>
            </div>
            {stepNumber < steps.length && (
              <div
                className={cn(
                  'mx-2 h-px flex-1 -translate-y-2.5',
                  isComplete ? 'bg-[#D90013]' : 'bg-input'
                )}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default StepIndicator
