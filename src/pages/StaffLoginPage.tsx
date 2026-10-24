import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, LoaderCircle, ShieldCheck } from 'lucide-react';
import { AuthError, createStaffAccount, isOfflinePreview, signIn, signalAuthChange, type AuthSession } from '../lib/auth';
import './staff-login.css';

interface StaffLoginProps {
  session: AuthSession | null;
  loading: boolean;
  error: string;
  notice: string;
  onRetry: () => void;
  onSignedIn: (session: AuthSession) => void;
}

export default function StaffLoginPage({ session, loading, error, notice, onRetry, onSignedIn }: StaffLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const setupRequired = session?.setupRequired === true;

  useEffect(() => {
    setPassword('');
    setConfirmation('');
    setSetupCode('');
  }, [setupRequired]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setFormError('');
    if (setupRequired && password !== confirmation) {
      setFormError('The passwords don’t match. Please enter them again.');
      return;
    }
    setSubmitting(true);
    try {
      const next = setupRequired
        ? await createStaffAccount(email.trim(), password, setupCode.trim())
        : await signIn(email.trim(), password);
      if (!next.user) throw new Error('Sign-in could not be completed. Please try again.');
      setPassword('');
      setConfirmation('');
      setSetupCode('');
      signalAuthChange();
      onSignedIn(next);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Sign-in could not be completed. Please try again.');
      if (cause instanceof AuthError && cause.status === 409) onRetry();
    } finally { setSubmitting(false); }
  }

  if (isOfflinePreview) {
    return <section className="staff-login" aria-labelledby="staff-login-heading">
      <div className="staff-login-card staff-login-message">
        <span className="staff-login-icon"><LockKeyhole size={26} /></span>
        <h1 id="staff-login-heading">Staff sign in</h1>
        <p>Staff access is available in the running app. This standalone preview supports the customer form and specialist directory.</p>
        <a href="http://127.0.0.1:5173/#login" className="btn btn-primary">Open staff sign in <ArrowRight size={17} /></a>
      </div>
      <a className="staff-login-back" href="#inspection"><ArrowLeft size={15} />Back to customer form</a>
    </section>;
  }

  if (loading || !session || error) {
    return <section className="staff-login" aria-labelledby="staff-login-heading">
      <div className="staff-login-card staff-login-message">
        <span className="staff-login-icon"><LockKeyhole size={26} /></span>
        <h1 id="staff-login-heading">Staff sign in</h1>
        {loading ? <p role="status"><LoaderCircle className="staff-spinner" size={18} />Checking staff access…</p>
          : <><p role="alert">{error || 'Staff access could not be loaded. Please try again.'}</p><button className="btn btn-primary" onClick={onRetry}>Try again</button></>}
      </div>
      <a className="staff-login-back" href="#inspection"><ArrowLeft size={15} />Back to customer form</a>
    </section>;
  }

  return <section className="staff-login" aria-labelledby="staff-login-heading">
    <header className="staff-login-heading">
      <span className="staff-login-icon"><ShieldCheck size={27} /></span>
      <h1 id="staff-login-heading">{setupRequired ? 'Set up staff access' : 'Staff sign in'}</h1>
      <p>{setupRequired ? 'Create the first account for your team.' : 'Sign in to review and manage client requests.'}</p>
    </header>
    <form className="staff-login-card" onSubmit={event => void submit(event)}>
      {notice && <p className="staff-login-notice" role="status">{notice}</p>}
      {setupRequired && <p className="staff-setup-help" id="setup-code-help">Use the one-time setup code shown in the app’s server terminal. Setup is available only until the first staff account is created.</p>}
      <fieldset disabled={submitting}>
        {setupRequired && <div className="staff-field">
          <label htmlFor="staff-setup-code">Setup code</label>
          <input id="staff-setup-code" name="setupCode" type="password" value={setupCode} onChange={event => setSetupCode(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} required aria-describedby="setup-code-help" />
        </div>}
        <div className="staff-field">
          <label htmlFor="staff-email">Email</label>
          <input id="staff-email" name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required />
        </div>
        <div className="staff-field">
          <label htmlFor="staff-password">Password</label>
          <input id="staff-password" name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={128} required aria-describedby={setupRequired ? 'staff-password-help' : undefined} />
          {setupRequired && <small id="staff-password-help">Use at least 12 characters.</small>}
        </div>
        {setupRequired && <div className="staff-field">
          <label htmlFor="staff-confirm-password">Confirm password</label>
          <input id="staff-confirm-password" name="confirmation" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required />
        </div>}
        {formError && <p className="staff-form-error" role="alert">{formError}</p>}
        <button className="btn btn-primary staff-submit" type="submit">
          {submitting ? <><LoaderCircle className="staff-spinner" size={18} />{setupRequired ? 'Creating account…' : 'Signing in…'}</>
            : <>{setupRequired ? 'Create staff account' : 'Sign in'}<ArrowRight size={17} /></>}
        </button>
      </fieldset>
    </form>
    <a className="staff-login-back" href="#inspection"><ArrowLeft size={15} />Back to customer form</a>
  </section>;
}
