// Shared controls, styled after Windows 11 (Fluent) controls.
import {
  CheckCircle,
  Info,
  WarningCircle,
  WarningOctagon,
  X,
  type Icon as PhosphorIcon
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { dismissToast, useStore } from "../store";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type ButtonProps = {
  children?: ReactNode;
  icon?: PhosphorIcon;
  variant?: "standard" | "accent" | "subtle";
  size?: "default" | "small";
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  "aria-label"?: string;
};

export function Button({
  children,
  icon: IconComponent,
  variant = "standard",
  size = "default",
  busy,
  disabled,
  title,
  onClick,
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={["btn", `btn-${variant}`, size === "small" ? "btn-small" : "", !children ? "btn-icon" : "", busy ? "is-busy" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || busy}
      title={title}
      onClick={onClick}
      aria-label={rest["aria-label"]}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner /> : IconComponent ? <IconComponent size={16} aria-hidden /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="1.5" />
    </svg>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch${disabled ? " is-disabled" : ""}`}>
      <span className="switch-state">{checked ? "On" : "Off"}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

const INFOBAR_ICONS = {
  info: Info,
  success: CheckCircle,
  warning: WarningCircle,
  error: WarningOctagon
} as const;

export function InfoBar({
  tone,
  title,
  children,
  actions,
  onDismiss
}: {
  tone: keyof typeof INFOBAR_ICONS;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}) {
  const IconComponent = INFOBAR_ICONS[tone];
  return (
    <div className={`infobar infobar-${tone}`} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
      <IconComponent className="infobar-icon" size={18} weight="fill" aria-hidden />
      <div className="infobar-body">
        <strong>{title}</strong>
        {children ? <span className="infobar-message">{children}</span> : null}
      </div>
      {actions ? <div className="infobar-actions">{actions}</div> : null}
      {onDismiss ? <Button variant="subtle" size="small" icon={X} aria-label="Dismiss" onClick={onDismiss} /> : null}
    </div>
  );
}

export function ProgressBar({ value, indeterminate, label }: { value?: number; indeterminate?: boolean; label: string }) {
  const percent = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      className={`progress${indeterminate ? " is-indeterminate" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      <div className="progress-fill" style={indeterminate ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// A Windows settings card: icon, title, description, and the control on the right.
export function SettingsCard({
  icon: IconComponent,
  title,
  description,
  children,
  below
}: {
  icon?: PhosphorIcon;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-main">
        {IconComponent ? <IconComponent className="settings-card-icon" size={20} aria-hidden /> : null}
        <div className="settings-card-text">
          <span className="settings-card-title">{title}</span>
          {description ? <span className="settings-card-description">{description}</span> : null}
        </div>
        {children ? <div className="settings-card-control">{children}</div> : null}
      </div>
      {below ? <div className="settings-card-below">{below}</div> : null}
    </div>
  );
}

export function EmptyState({ icon: IconComponent, title, children, actions }: { icon: PhosphorIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <IconComponent className="empty-icon" size={40} weight="light" aria-hidden />
      <strong className="empty-title">{title}</strong>
      {children ? <p className="empty-copy">{children}</p> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Dialog({
  open,
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>("input, button")?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panelRef} className={`dialog${wide ? " dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-content">
          <h2 id={titleId} className="dialog-title">{title}</h2>
          {subtitle ? <p className="dialog-subtitle">{subtitle}</p> : null}
          {children}
        </div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((current) => current.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          {item.tone === "success" ? <CheckCircle size={16} weight="fill" aria-hidden /> : item.tone === "error" ? <WarningOctagon size={16} weight="fill" aria-hidden /> : null}
          <span>{item.message}</span>
          {item.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                item.action?.run();
                dismissToast(item.id);
              }}
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function PathText({ value, placeholder }: { value: string; placeholder: string }) {
  return value ? (
    <span className="path" title={value}>{value}</span>
  ) : (
    <span className="path is-empty">{placeholder}</span>
  );
}
