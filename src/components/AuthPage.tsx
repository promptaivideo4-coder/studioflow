import React, { useState, useId } from 'react';
import {captureCustomerReferral,rememberCustomerReferral,clearCustomerReferral} from '../lib/customerReferral';
import { cleanCustomerAppReturnPath, clearOAuthIntent, readAuthUrlError, saveOAuthIntent } from '../lib/authEntry';
import {whatsappNational,validCustomerWhatsApp,customerWhatsApp} from '../lib/customerWhatsApp';
import {customerToday,validCustomerBirthDate} from '../lib/customerBirthDate';
import { requestedTemplate } from '../lib/templateEntry';
import { isBillingInterval, isPricingPlanId, pricingResumePath } from '../lib/nexoraPricing';
import { Eye, EyeOff } from 'lucide-react';
import { supabase, captureReferral } from '../lib/supabase';

export function AuthPage({ compact = false, recovery = false, onRecovered, customerMode, initialMode, returnSlug, invitationMode=false, redirectPathOverride }: { key?:React.Key; compact?: boolean; recovery?: boolean; onRecovered?: () => void; customerMode?:boolean; initialMode?:'signin'|'signup'; returnSlug?:string; invitationMode?:boolean; redirectPathOverride?:string }) {
  const passwordId = useId(); const confirmId = useId();
  const [confirmVisible, setConfirmVisible] = useState(false);
  const search = typeof location === 'undefined' ? '' : (location.search || '');
  const hash = typeof location === 'undefined' ? '' : (location.hash || '');
  const origin = typeof location === 'undefined' ? '' : (location.origin || '');
  const loginParams=new URLSearchParams(search);
  const customer = customerMode ?? loginParams.has('customer');
  const customerReturn=returnSlug||loginParams.get('return');
  const selectedTemplate=requestedTemplate(search);
  const pricingPlanId=loginParams.get('pricing_plan');
  const pricingBilling=loginParams.get('billing_interval');
  const pricingReturnPath=isPricingPlanId(pricingPlanId)?pricingResumePath({planId:pricingPlanId,billingInterval:isBillingInterval(pricingBilling)?pricingBilling:'annual'}):'';
  const pendingCustomerRef=customer?captureCustomerReferral():'';
  const baseRedirectPath=loginParams.has('app')?'/?app=1':customer?`/?customer=1${customerReturn?'&return='+encodeURIComponent(customerReturn):''}`:selectedTemplate?`/?template=${encodeURIComponent(selectedTemplate.id)}&create=1`:pricingReturnPath||'/';
  const redirectPath=baseRedirectPath+(pendingCustomerRef?(baseRedirectPath.includes('?')?'&':'?')+'customer_ref='+encodeURIComponent(pendingCustomerRef):'');
  const [mode, setMode] = useState<'signin'|'signup'|'forgot'>((loginParams.get('auth') === 'forgot' ? 'forgot' : loginParams.get('auth')==='signin'?'signin':initialMode) || (loginParams.get('auth')==='signup' || (customer?pendingCustomerRef:captureReferral()) ? 'signup' : 'signin'));
  const signup = mode === 'signup';
  const [welcomeWhatsApp,setWelcomeWhatsApp]=useState(false);
  const [birthDate,setBirthDate]=useState('');const [whatsapp,setWhatsapp]=useState('');
  const [name, setName] = useState(''); const [salon, setSalon] = useState('');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(''); const [visible, setVisible] = useState(false);
  const [ref, setRef] = useState(()=>customer?captureCustomerReferral():captureReferral()); const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [message, setMessage] = useState(() => readAuthUrlError(search, hash) || (loginParams.has('recovery') && !recovery ? 'Reset link expired or could not be verified. Request a new link using Forgot password.' : '')); const [confirmationPending, setConfirmationPending] = useState(false);

  const normalizedRef = ref.trim().toUpperCase();
  const pricingLoginPath = pricingReturnPath
    ? `/login?pricing_plan=${encodeURIComponent(pricingPlanId!)}&billing_interval=${encodeURIComponent(isBillingInterval(pricingBilling) ? pricingBilling : 'annual')}`
    : '';
  const ownerSlugParam = loginParams.get('owner');
  const panelParam = loginParams.has('panel') ? (loginParams.get('panel') || '1') : '';
  const oauthCustomerRef = customer ? ((signup || invitationMode) ? normalizedRef : pendingCustomerRef) : '';
  const oauthRedirectPath = invitationMode
    ? '/?app=1&tab=rewards'
    : redirectPathOverride
      ? redirectPathOverride + (oauthCustomerRef ? (redirectPathOverride.includes('?') ? '&' : '?') + 'customer_ref=' + encodeURIComponent(oauthCustomerRef) : '')
      : loginParams.has('app')
        ? cleanCustomerAppReturnPath(search, (signup || invitationMode) ? normalizedRef : undefined)
        : customer
          ? baseRedirectPath + (oauthCustomerRef ? (baseRedirectPath.includes('?') ? '&' : '?') + 'customer_ref=' + encodeURIComponent(oauthCustomerRef) : '')
          : selectedTemplate
            ? `/?template=${encodeURIComponent(selectedTemplate.id)}&create=1`
            : pricingLoginPath || (ownerSlugParam ? `/?owner=${encodeURIComponent(ownerSlugParam)}` : panelParam ? `/?panel=${encodeURIComponent(panelParam)}` : '/login');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      if (recovery) {
        if (password !== confirm) throw new Error('Passwords do not match.');
        const { error } = await supabase.auth.updateUser({ password }); if (error) throw error;
        sessionStorage.removeItem('studioflow_recovery');
        await supabase.auth.signOut({ scope: 'local' });
        location.assign(`${redirectPath}${redirectPath.includes('?') ? '&' : '?'}passwordUpdated=1`); return;
      }
      if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${origin}${redirectPath}${redirectPath.includes('?') ? '&' : '?'}recovery=1` });
        if (error) throw error;
        setResetSent(true);
        setMessage('If an account exists for this email, a password reset link will be sent. Open that link to choose a new password.'); return;
      }
      if(signup&&customer&&(!whatsapp||!validCustomerWhatsApp(whatsapp)))throw new Error('Enter a valid 10-digit WhatsApp number. +91 is already added.');
      if(signup&&customer&&(!birthDate||!validCustomerBirthDate(birthDate)))throw new Error('Enter a valid date of birth from 1900 through today.');
      if (signup && normalizedRef) {
        const { data, error } = await supabase.rpc(customer?'studioflow_customer_validate_ref':'studioflow_validate_ref', { p_code: normalizedRef });
        if (error) throw new Error(error.message); if (!data) throw new Error('Referral code is invalid or inactive. Check it or leave it empty.');
      }
      if(signup&&customer)rememberCustomerReferral(ref);
      if (signup && !customer) {
        localStorage.removeItem('studioflow_pending_ref');
        const url = new URL(location.href); url.searchParams.delete('ref'); history.replaceState(null, '', url);
        if (normalizedRef) localStorage.setItem('studioflow_pending_ref', normalizedRef);
      }
      if(invitationMode&&signup){const current=await supabase.auth.getSession();if(current.error)throw new Error(current.error.message);if(current.data.session){const out=await supabase.auth.signOut({scope:'local'});if(out.error)throw new Error(out.error.message);}}
      const result = signup ? await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${origin}${invitationMode?'/?app=1&tab=rewards':customer?baseRedirectPath+(normalizedRef?(baseRedirectPath.includes('?')?'&':'?')+'customer_ref='+encodeURIComponent(normalizedRef):''):redirectPath}`, data: { full_name: name.trim(), salon_name: salon.trim(), ...(customer?{customer_referral_code:normalizedRef,date_of_birth:birthDate||null,whatsapp_number:customerWhatsApp(whatsapp),whatsapp_welcome_opt_in:welcomeWhatsApp}:{referral_code:normalizedRef}), source: 'studioflow' } } }) : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message);
      if(invitationMode&&result.data.session){clearCustomerReferral();location.assign('/?app=1&tab=rewards');return;}
      if(result.data.session&&pricingReturnPath){location.assign(pricingReturnPath);return;}
      if (signup && !result.data.session) { setConfirmationPending(true); setMessage('Check your email to confirm your account, then sign in. If you already have an account, use Sign in or Forgot password.'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : (typeof (error as { message?: unknown })?.message === 'string' && (error as { message: string }).message) || 'Could not complete this request. Please try again.'); }
    finally { setBusy(false); }
  };
  const signInWithGoogle = async () => {
    setBusy(true); setMessage('');
    try {
      if ((signup || invitationMode) && normalizedRef) {
        const { data, error } = await supabase.rpc(customer ? 'studioflow_customer_validate_ref' : 'studioflow_validate_ref', { p_code: normalizedRef });
        if (error) throw new Error(error.message);
        if (!data) throw new Error('Referral code is invalid or inactive. Check it or leave it empty.');
      }
      if ((signup || invitationMode) && customer) {
        if (normalizedRef) rememberCustomerReferral(normalizedRef);
        else if (typeof location !== 'undefined' && location.href) clearCustomerReferral();
      }
      if (signup && !customer) {
        try { localStorage.removeItem('studioflow_pending_ref'); } catch {}
        if (typeof location !== 'undefined' && location.href && typeof history !== 'undefined') {
          const url = new URL(location.href);
          url.searchParams.delete('ref');
          history.replaceState(null, '', url);
        }
        if (normalizedRef) {
          try { localStorage.setItem('studioflow_pending_ref', normalizedRef); } catch {}
        }
      }
      if (invitationMode) {
        const current = await supabase.auth.getSession();
        if (current.error) throw new Error(current.error.message);
        if (current.data.session) {
          const out = await supabase.auth.signOut({ scope: 'local' });
          if (out.error) throw new Error(out.error.message);
        }
      }
      // Persist the owner-vs-customer intent so the post-OAuth return lands in the same flow as email sign-in.
      saveOAuthIntent({
        path: oauthRedirectPath,
        flow: invitationMode ? 'invite' : loginParams.has('app') ? 'app' : customer ? 'customer' : 'owner',
      });
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}${oauthRedirectPath}`,
          queryParams: { prompt: 'select_account' },
        },
      });
      if (error) throw new Error(error.message);
      if (!data?.url) setBusy(false);
    } catch (error) {
      clearOAuthIntent();
      setMessage(error instanceof Error ? error.message : (typeof (error as { message?: unknown })?.message === 'string' && (error as { message: string }).message) || 'Could not complete Google sign-in. Please try again.');
      setBusy(false);
    }
  };
  const resend = async () => {
    setBusy(true); setMessage('');
    const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: `${origin}${invitationMode?'/?app=1&tab=rewards':redirectPath}` } });
    setMessage(error ? error.message : 'Confirmation email requested. Check your inbox and spam folder.'); setBusy(false);
  };
  const standardSignIn = !compact && !recovery && mode === 'signin' && !customer;
  const pageHeading = recovery ? 'Choose a new password' : mode === 'forgot' ? 'Reset your password' : signup ? customer ? 'Create your customer account' : 'Create your salon account' : standardSignIn ? 'Sign in to NEXORA Salon OS.' : 'Welcome back';
  const pageDescription = recovery ? 'Enter and confirm your new password to securely update your account.' : mode === 'forgot' ? 'Enter your registered email. We will send you a link to choose a new password. Check your inbox and spam folder.' : customer ? 'Sign in to book appointments and manage your bookings.' : standardSignIn ? 'Sign in to access your existing salon website, team and business information, with your account data available across devices.' : 'Your website, team and business data stay with your account across devices.';
  return <main className={compact ? '' : 'min-h-screen bg-[#f9f9ff] px-4 py-12 flex items-center justify-center'}>
    <section className="workspace-card w-full max-w-lg">
      <p className="eyebrow">NEXORA · Salon OS</p><h1 className="text-3xl font-bold mb-2">{pageHeading}</h1>
      <p className="muted mb-5">{pageDescription}</p>
      {!recovery && mode !== 'forgot' && <div className="flex gap-3 mb-5"><button disabled={busy} type="button" className={signup ? 'secondary-action' : 'primary-action'} onClick={() => { setMode('signin'); setMessage(''); }}>Sign in</button><button disabled={busy} type="button" className={signup ? 'primary-action' : 'secondary-action'} onClick={() => { setMode('signup'); setMessage(''); }}>Sign up</button></div>}
      {!recovery && loginParams.has('passwordUpdated') && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-green-900">Password updated successfully. Sign in with your new password.</p>}
      {!recovery && mode !== 'forgot' && <><button type="button" disabled={busy} onClick={() => void signInWithGoogle()} className="secondary-action w-full justify-center mb-3">Continue with Google</button><p className="text-center text-xs text-slate-500 mb-4">or use email</p></>}
      <form onSubmit={submit} className="space-y-4">
        {signup && !recovery && <><label className="block">Full name<input className="workspace-input" autoComplete="name" maxLength={150} value={name} onChange={e => setName(e.target.value)} required /></label>{!customer && <label className="block">Salon name<input className="workspace-input" maxLength={150} value={salon} onChange={e => setSalon(e.target.value)} required /></label>}</>}
        {signup&&customer&&!recovery&&<label className="block">Date of Birth<input className="workspace-input" type="date" required autoComplete="bday" min="1900-01-01" max={customerToday()} value={birthDate} onChange={e=>setBirthDate(e.target.value)}/><small>Your date of birth stays private and is not shared with your inviter.</small></label>}
        {signup&&customer&&!recovery&&<label className="block">WhatsApp number<div className="flex items-center gap-2"><span aria-label="India country code" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 font-semibold">+91</span><input className="workspace-input flex-1 min-w-0" type="tel" required minLength={10} pattern="[1-9][0-9]{9}" inputMode="numeric" autoComplete="tel-national" placeholder="10-digit WhatsApp number" aria-label="WhatsApp number" maxLength={16} value={whatsapp} onChange={e=>setWhatsapp(whatsappNational(e.target.value))}/></div><small>Your number stays private and is not shared with your inviter.</small></label>}
        {!recovery && <label className="block">Email<input className="workspace-input" type="email" autoComplete="email" required value={email} onChange={e => { setEmail(e.target.value); setResetSent(false); }} /></label>}
        {(recovery || mode !== 'forgot') && <div>
          <div className="flex items-center justify-between gap-3"><label htmlFor={passwordId}>{recovery ? 'New password' : 'Password'}</label>{!recovery && mode === 'signin' && <button type="button" disabled={busy} className="text-sm font-semibold text-violet-700 underline underline-offset-4 py-2" onClick={() => { setMode('forgot'); setMessage(''); setResetSent(false); }}>Forgot password?</button>}</div>
          <div className="relative"><input id={passwordId} className="workspace-input" style={{paddingRight:52}} type={visible ? 'text' : 'password'} minLength={6} autoComplete={signup || recovery ? 'new-password' : 'current-password'} required value={password} onChange={e => setPassword(e.target.value)} /><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} aria-controls={passwordId} title={visible ? 'Hide password' : 'Show password'} className="absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:text-violet-700 focus-visible:outline-2 focus-visible:outline-violet-600" onClick={() => setVisible(v => !v)}>{visible ? <EyeOff size={20} aria-hidden="true"/> : <Eye size={20} aria-hidden="true"/>}</button></div>
        </div>}
        {recovery && <div><label htmlFor={confirmId}>Confirm new password</label><div className="relative"><input id={confirmId} className="workspace-input" style={{paddingRight:52}} type={confirmVisible ? 'text' : 'password'} minLength={6} autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /><button type="button" aria-label={confirmVisible ? 'Hide confirm password' : 'Show confirm password'} aria-pressed={confirmVisible} aria-controls={confirmId} title={confirmVisible ? 'Hide confirm password' : 'Show confirm password'} className="absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:text-violet-700 focus-visible:outline-2 focus-visible:outline-violet-600" onClick={() => setConfirmVisible(v => !v)}>{confirmVisible ? <EyeOff size={20} aria-hidden="true"/> : <Eye size={20} aria-hidden="true"/>}</button></div></div>}
        {signup && !recovery && <label className="block">Referral code <span className="text-gray-400">(optional)</span><input className="workspace-input" maxLength={32} value={ref} onChange={e => setRef(e.target.value.toUpperCase())} /><small>{customer?'Your name, join date and referral progress will be visible to your inviter. Email, phone and photos stay private.':'Referral attribution is saved after you sign in.'}</small></label>}
        {signup&&customer&&!recovery&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={welcomeWhatsApp} onChange={e=>setWelcomeWhatsApp(e.target.checked)} className="mt-1"/><span>Request my Nexora welcome message on WhatsApp after email confirmation, with my User ID, login link and referral link. My password will not be sent.</span></label>}
        {message && <p role="status" className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900">{message}</p>}
        <button disabled={busy || (mode === 'forgot' && resetSent)} className="primary-action w-full justify-center disabled:opacity-60">{busy ? 'Please wait…' : recovery ? 'Save new password' : mode === 'forgot' ? resetSent ? 'Reset link requested — check email' : 'Send reset link' : signup ? 'Create account' : 'Sign in'}</button>
        {!recovery && mode === 'forgot' && <button type="button" disabled={busy} className="secondary-action w-full justify-center" onClick={() => { setMode('signin'); setMessage(''); setResetSent(false); }}>Back to sign in</button>}
        {confirmationPending && signup && <button type="button" disabled={busy} className="secondary-action" onClick={() => void resend()}>Resend confirmation email</button>}
      </form>
    </section>
  </main>;
}
