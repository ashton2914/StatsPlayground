import type { ButtonHTMLAttributes, ReactNode } from "react";

export type AnalysisButtonTone = "default" | "primary" | "danger";

interface AnalysisButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: AnalysisButtonTone;
  pending?: boolean;
  pendingLabel?: ReactNode;
}

export function AnalysisButton({
  tone = "default",
  pending = false,
  pendingLabel,
  disabled,
  type = "button",
  className,
  children,
  ...props
}: AnalysisButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={["analysis-ui-button", `analysis-ui-button-${tone}`, className].filter(Boolean).join(" ")}
    >
      {pending ? pendingLabel ?? children : children}
    </button>
  );
}