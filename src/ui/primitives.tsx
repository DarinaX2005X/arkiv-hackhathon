import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type SVGProps,
  type TextareaHTMLAttributes,
} from 'react';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function describedBy(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ') || undefined;
}

type PendingButton =
  | { pending: true; pendingLabel: string }
  | { pending?: false; pendingLabel?: string };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & PendingButton & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'regular' | 'compact';
  disabledReason?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className, variant = 'primary', size = 'regular', pending = false,
    pendingLabel, disabled, disabledReason, type = 'button', ...props }, ref,
) {
  const reasonId = useId();
  const isDisabled = disabled || pending;
  const button = (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes('pf-button', `pf-button--${variant}`, `pf-button--${size}`, className)}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      aria-describedby={describedBy(props['aria-describedby'], isDisabled && !!disabledReason && reasonId)}
    >
      {pending && <span className="pf-spinner" aria-hidden="true" />}
      <span>{pending ? pendingLabel : children}</span>
    </button>
  );
  return isDisabled && disabledReason ? (
    <span className="pf-button-explanation">
      {button}
      <span className="pf-field-message" id={reasonId}>{disabledReason}</span>
    </span>
  ) : button;
});

export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function Link({ className, children, ...props }, ref) {
    return <a {...props} ref={ref} className={classes('pf-link', className)}>{children}</a>;
  },
);

export interface FieldMessageProps extends HTMLAttributes<HTMLParagraphElement> {
  tone?: Tone;
}

export function FieldMessage({ tone = 'neutral', className, ...props }: FieldMessageProps) {
  return <p {...props} className={classes('pf-field-message', `pf-text--${tone}`, className)} />;
}

interface FieldDecoration {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
}

function FieldText({ id, hint, error }: { id: string; hint?: ReactNode; error?: ReactNode }) {
  return <>
    {hint && <FieldMessage id={`${id}-hint`}>{hint}</FieldMessage>}
    {error && <FieldMessage id={`${id}-error`} tone="danger" role="alert">{error}</FieldMessage>}
  </>;
}

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & FieldDecoration;

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { id: suppliedId, label, hint, error, containerClassName, className, ...props }, ref,
) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className={classes('pf-field', containerClassName)}>
      <label className="pf-field-label" htmlFor={id}>{label}</label>
      <input
        {...props} id={id} ref={ref}
        className={classes('pf-input', className)}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(props['aria-describedby'], !!hint && `${id}-hint`, !!error && `${id}-error`)}
      />
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldDecoration;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id: suppliedId, label, hint, error, containerClassName, className, ...props }, ref,
) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className={classes('pf-field', containerClassName)}>
      <label className="pf-field-label" htmlFor={id}>{label}</label>
      <textarea
        {...props} id={id} ref={ref}
        className={classes('pf-input', 'pf-textarea', className)}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(props['aria-describedby'], !!hint && `${id}-hint`, !!error && `${id}-error`)}
      />
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldDecoration & {
  options?: readonly SelectOption[];
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id: suppliedId, label, hint, error, containerClassName, className, options, children, ...props }, ref,
) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className={classes('pf-field', containerClassName)}>
      <label className="pf-field-label" htmlFor={id}>{label}</label>
      <select
        {...props} id={id} ref={ref}
        className={classes('pf-input', 'pf-select', className)}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(props['aria-describedby'], !!hint && `${id}-hint`, !!error && `${id}-error`)}
      >
        {options?.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        {children}
      </select>
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
});

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & FieldDecoration;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { id: suppliedId, label, hint, error, containerClassName, className, ...props }, ref,
) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className={classes('pf-field', 'pf-checkbox-field', containerClassName)}>
      <label className="pf-checkbox-label" htmlFor={id}>
        <input
          {...props} id={id} ref={ref} type="checkbox"
          className={classes('pf-checkbox', className)}
          aria-invalid={error ? true : props['aria-invalid']}
          aria-describedby={describedBy(props['aria-describedby'], !!hint && `${id}-hint`, !!error && `${id}-error`)}
        />
        <span>{label}</span>
      </label>
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
});

export interface StatusLabelProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  children: ReactNode;
}

/** The caller supplies the verified state and its localized, visible label. */
export function StatusLabel({ tone = 'neutral', className, children, ...props }: StatusLabelProps) {
  return <span {...props} className={classes('pf-status', `pf-status--${tone}`, className)}>{children}</span>;
}

export interface NoticeProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}

export function Notice({ tone = 'neutral', title, children, actions, className, role, ...props }: NoticeProps) {
  return (
    <aside {...props} role={role} className={classes('pf-notice', `pf-notice--${tone}`, className)}>
      {title && <p className="pf-notice-title">{title}</p>}
      <div className="pf-notice-body">{children}</div>
      {actions && <div className="pf-actions">{actions}</div>}
    </aside>
  );
}

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Caller can keep open and ask for a discard decision when work is unsaved. */
  onClose: (reason: 'escape' | 'close-button') => void;
}

export function Dialog({ open, title, description, closeLabel, children, footer, className, onClose }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const initiator = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (initiator instanceof HTMLElement && initiator.isConnected) initiator.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={classes('pf-dialog', className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={event => { event.preventDefault(); onClose('escape'); }}
    >
      <header className="pf-dialog-header">
        <h2 id={titleId}>{title}</h2>
        <Button variant="quiet" size="compact" onClick={() => onClose('close-button')}>{closeLabel}</Button>
      </header>
      {description && <p id={descriptionId} className="pf-dialog-description">{description}</p>}
      <div className="pf-dialog-body">{children}</div>
      {footer && <footer className="pf-dialog-footer pf-actions">{footer}</footer>}
    </dialog>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  label: string;
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/** Panels stay mounted so changing tabs does not discard the caller's drafts. */
export function Tabs({ label, items, value, onValueChange, className }: TabsProps) {
  const baseId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const enabled = items.filter(item => !item.disabled);
    const current = enabled.findIndex(item => item.id === id);
    if (current < 0 || !enabled.length) return;
    let next: TabItem | undefined;
    if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length];
    if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length];
    if (event.key === 'Home') next = enabled[0];
    if (event.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    onValueChange(next.id);
    buttons.current.get(next.id)?.focus();
  }
  return (
    <div className={classes('pf-tabs', className)}>
      <div className="pf-tab-list" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.id} type="button" role="tab"
            id={`${baseId}-tab-${index}`} aria-controls={`${baseId}-panel-${index}`}
            aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
            disabled={item.disabled} className="pf-tab"
            ref={node => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id); }}
            onClick={() => onValueChange(item.id)} onKeyDown={event => handleKey(event, item.id)}
          >{item.label}</button>
        ))}
      </div>
      {items.map((item, index) => (
        <div
          key={item.id} role="tabpanel" id={`${baseId}-panel-${index}`}
          aria-labelledby={`${baseId}-tab-${index}`} hidden={value !== item.id}
          tabIndex={0} className="pf-tab-panel"
        >{item.content}</div>
      ))}
    </div>
  );
}

export interface StateProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function LoadingState({ title, description, actions, children, className }: StateProps) {
  return (
    <section className={classes('pf-state', 'pf-loading', className)}>
      <div role="status" aria-live="polite">
        <p className="pf-state-title"><span className="pf-spinner" aria-hidden="true" />{title}</p>
        {description && <p className="pf-state-description">{description}</p>}
      </div>
      {children}
      {actions && <div className="pf-actions">{actions}</div>}
    </section>
  );
}

export function EmptyState({ title, description, actions, children, className }: StateProps) {
  const titleId = useId();
  return (
    <section className={classes('pf-state', 'pf-empty', className)} aria-labelledby={titleId}>
      <h3 id={titleId} className="pf-state-title">{title}</h3>
      {description && <p className="pf-state-description">{description}</p>}
      {children}
      {actions && <div className="pf-actions">{actions}</div>}
    </section>
  );
}

export function ErrorState({ title, description, actions, children, className }: StateProps) {
  return (
    <section className={classes('pf-state', 'pf-error', className)}>
      <div role="alert">
        <h3 className="pf-state-title">{title}</h3>
        {description && <p className="pf-state-description">{description}</p>}
      </div>
      {children}
      {actions && <div className="pf-actions">{actions}</div>}
    </section>
  );
}

export interface RequirementRowProps {
  title: ReactNode;
  conditions?: ReactNode;
  contributions: ReactNode;
  status: ReactNode;
  coverage?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Presentation only: all coverage and consent claims come from the domain layer. */
export function RequirementRow({ title, conditions, contributions, status, coverage, action, className }: RequirementRowProps) {
  const titleId = useId();
  return (
    <article className={classes('pf-requirement-row', className)} aria-labelledby={titleId}>
      <div className="pf-requirement-details">
        <h3 className="pf-row-title" id={titleId}>{title}</h3>
        {conditions && <div className="pf-row-conditions">{conditions}</div>}
        {coverage && <p className="pf-coverage">{coverage}</p>}
      </div>
      <div className="pf-requirement-contributions">{contributions}</div>
      <div className="pf-row-outcome">{status}{action && <div className="pf-row-action">{action}</div>}</div>
    </article>
  );
}

export interface ContributionRowProps {
  title: ReactNode;
  owner: ReactNode;
  community?: ReactNode;
  conditions?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  selected?: boolean;
  className?: string;
}

export function ContributionRow({ title, owner, community, conditions, status, action, selected = false, className }: ContributionRowProps) {
  const titleId = useId();
  return (
    <article className={classes('pf-contribution-row', selected && 'pf-contribution-row--selected', className)} aria-labelledby={titleId}>
      <div className="pf-contribution-details">
        <h4 className="pf-row-title" id={titleId}>{title}</h4>
        <p className="pf-contribution-owner"><span>{owner}</span>{community && <>{' '}<span className="pf-contribution-community">from {community}</span></>}</p>
        {conditions && <div className="pf-row-conditions">{conditions}</div>}
      </div>
      {(status || action) && <div className="pf-row-outcome">{status}{action && <div className="pf-row-action">{action}</div>}</div>}
    </article>
  );
}

export interface PlanDiffRow {
  id: string;
  label: ReactNode;
  before: ReactNode;
  after: ReactNode;
  detail?: ReactNode;
}

export interface PlanDiffProps {
  title: string;
  labels: { requirement: string; before: string; after: string };
  rows: readonly PlanDiffRow[];
  footer?: ReactNode;
  className?: string;
}

export function PlanDiff({ title, labels, rows, footer, className }: PlanDiffProps) {
  return (
    <div className={classes('pf-plan-diff', className)}>
      <table role="table">
        <caption>{title}</caption>
        <thead role="rowgroup"><tr role="row">
          <th role="columnheader" scope="col">{labels.requirement}</th>
          <th role="columnheader" scope="col">{labels.before}</th>
          <th role="columnheader" scope="col">{labels.after}</th>
        </tr></thead>
        <tbody role="rowgroup">{rows.map(row => <tr role="row" key={row.id}>
          <th role="rowheader" scope="row">{row.label}{row.detail && <div className="pf-diff-detail">{row.detail}</div>}</th>
          <td role="cell"><span className="pf-diff-mobile-label" aria-hidden="true">{labels.before}</span>{row.before}</td>
          <td role="cell"><span className="pf-diff-mobile-label" aria-hidden="true">{labels.after}</span>{row.after}</td>
        </tr>)}</tbody>
      </table>
      {footer && <div className="pf-diff-footer">{footer}</div>}
    </div>
  );
}

/** Decorative mark: put the localized accessible name on its link when used alone. */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <svg {...props} width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={classes('pf-brand-mark', className)}>
    <path d="M3 3H7V21H3Z" />
    <path d="M9 3H21V7H9Z" />
    <path d="M17 9H21V17H9V13H17Z" />
  </svg>;
}

export { Notice as InlineNotice, LoadingState as Loading, EmptyState as Empty, ErrorState as Error };
