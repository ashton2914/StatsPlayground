import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

import "./formControls.css";

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

interface FieldContextValue {
  controlId: string;
  descriptionId?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  controlId?: string;
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  controlId: providedControlId,
}: FieldProps) {
  const generatedId = useId();
  const controlId = providedControlId ?? `ui-control-${generatedId.replace(/:/g, "")}`;
  const description = error ?? hint;
  const descriptionId = description ? `${controlId}-description` : undefined;

  return (
    <div className={joinClassNames("ui-field", className)}>
      <label className="ui-field-label" htmlFor={controlId}>{label}</label>
      <FieldContext.Provider value={{ controlId, descriptionId, invalid: Boolean(error) }}>
        {children}
      </FieldContext.Provider>
      {description && (
        <div
          className={joinClassNames("ui-field-description", Boolean(error) && "ui-field-error")}
          id={descriptionId}
        >
          {description}
        </div>
      )}
    </div>
  );
}

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextField({ className, id, "aria-describedby": describedBy, "aria-invalid": invalid, ...props }, ref) {
    const field = useContext(FieldContext);
    return (
      <input
        {...props}
        ref={ref}
        id={id ?? field?.controlId}
        className={joinClassNames("ui-input", className)}
        aria-describedby={describedBy ?? field?.descriptionId}
        aria-invalid={(invalid ?? field?.invalid) || undefined}
      />
    );
  },
);

interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  fieldClassName?: string;
  onValueChange?: (value: number | null) => void;
}

export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(
  function NumberField({ label, hint, error, fieldClassName, onValueChange, ...props }, ref) {
    return (
      <Field label={label} hint={hint} error={error} className={fieldClassName}>
        <TextField
          {...props}
          ref={ref}
          type="number"
          inputMode="decimal"
          onChange={(event) => {
            const raw = event.target.value;
            onValueChange?.(raw === "" ? null : Number(raw));
          }}
        />
      </Field>
    );
  },
);

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  fieldClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ label, hint, error, fieldClassName, className, id, children, ...props }, ref) {
    const field = useContext(FieldContext);
    const generatedId = useId();
    const controlId = id ?? field?.controlId ?? `ui-select-${generatedId.replace(/:/g, "")}`;
    const descriptionId = props["aria-describedby"] ?? field?.descriptionId ?? (
      label !== undefined && (error || hint) ? `${controlId}-description` : undefined
    );
    const control = (
      <select
        {...props}
        ref={ref}
        id={controlId}
        className={joinClassNames("ui-select", className)}
        aria-describedby={descriptionId}
        aria-invalid={(props["aria-invalid"] ?? field?.invalid ?? Boolean(error)) || undefined}
      >
        {children}
      </select>
    );
    return label === undefined
      ? control
      : <Field label={label} hint={hint} error={error} className={fieldClassName} controlId={controlId}>{control}</Field>;
  },
);

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  children: ReactNode;
  hint?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ children, hint, className, id, ...props }, ref) {
    const generatedId = useId();
    const controlId = id ?? `ui-checkbox-${generatedId.replace(/:/g, "")}`;
    const hintId = hint ? `${controlId}-description` : undefined;
    return (
      <div className="ui-checkbox-field">
        <label className={joinClassNames("ui-checkbox", className)} htmlFor={controlId}>
          <input {...props} ref={ref} id={controlId} type="checkbox" aria-describedby={hintId} />
          <span className="ui-checkbox-indicator" aria-hidden="true" />
          <span className="ui-checkbox-label">{children}</span>
        </label>
        {hint && <div className="ui-field-description ui-checkbox-description" id={hintId}>{hint}</div>}
      </div>
    );
  },
);

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "icon";
  size?: "small" | "medium";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ variant = "secondary", size = "medium", className, type = "button", ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={joinClassNames("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)}
      />
    );
  },
);
