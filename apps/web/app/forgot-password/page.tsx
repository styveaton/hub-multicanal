"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AuthLayout } from "../components/AuthLayout";
import { useI18n } from "../i18n/I18nProvider";
import { api, type Me } from "../lib/api";

interface CodeSent {
  expiresInSeconds: number;
  resendInSeconds: number;
}

/** 95 → « 1:35 » */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Secondes restantes avant `deadline`, mises à jour chaque seconde. */
function useSecondsLeft(deadline: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Mot de passe oublié : 1) l'email, 2) le code à 6 chiffres reçu (valable 2 minutes, compte à rebours)
 * et le nouveau mot de passe. Le changement ferme les autres sessions et connecte la personne.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const { t } = useI18n();
  const f = t.forgot;
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const left = useSecondsLeft(expiresAt);
  const resendLeft = useSecondsLeft(resendAt);
  const expired = step === "code" && left === 0;

  async function sendCode(address: string) {
    setPending(true);
    setError(null);
    const res = await api<CodeSent>("/auth/password/forgot", { method: "POST", body: { email: address } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    const now = Date.now();
    setExpiresAt(now + res.data.expiresInSeconds * 1000);
    setResendAt(now + res.data.resendInSeconds * 1000);
    return true;
  }

  async function onEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (await sendCode(address)) {
      setEmail(address);
      setInfo(null);
      setStep("code");
    }
  }

  async function onResend() {
    if (await sendCode(email)) setInfo(f.resent);
  }

  async function onReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirm")) {
      setError(f.mismatch);
      return;
    }
    setPending(true);
    setError(null);
    setInfo(null);
    const res = await api<Me>("/auth/password/reset", {
      method: "POST",
      body: { email, code: String(form.get("code") ?? ""), password },
    });
    setPending(false);
    if (res.ok) router.push("/products");
    else {
      if (res.code === "code_expired") setExpiresAt(Date.now());
      setError(res.message);
    }
  }

  return (
    <AuthLayout title={f.title} subtitle={step === "email" ? f.subtitle : undefined} footer={<Link href="/login">{f.backToLogin}</Link>}>
      {step === "email" ? (
        <form className="form" onSubmit={onEmail}>
          <label className="field">
            {t.common.email}
            <input className="input" name="email" type="email" required autoComplete="email" defaultValue={email} autoFocus />
          </label>
          {error && <Alert kind="error">{error}</Alert>}
          <button className="btn btn--block" disabled={pending}>
            {pending ? f.sending : f.sendCode}
          </button>
        </form>
      ) : (
        <form className="form" onSubmit={onReset}>
          <p className="muted">{f.sentTo(email)}</p>
          <label className="field">
            {f.code}
            <input
              className="input otp-input"
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="000000"
              autoFocus
            />
          </label>
          <p
            className={`otp-timer${expired ? " otp-timer--over" : left <= 30 ? " otp-timer--low" : ""}`}
            role={expired ? "alert" : undefined}
            aria-live="polite"
          >
            {expired ? f.expired : f.timeLeft(clock(left))}
          </p>
          <label className="field">
            {f.newPassword}
            <input className="input" name="password" type="password" required minLength={8} autoComplete="new-password" />
            <span className="field-hint">{t.common.minPassword}</span>
          </label>
          <label className="field">
            {f.confirmPassword}
            <input className="input" name="confirm" type="password" required minLength={8} autoComplete="new-password" />
          </label>
          {error && <Alert kind="error">{error}</Alert>}
          {info && <Alert kind="success">{info}</Alert>}
          <button className="btn btn--block" disabled={pending || expired}>
            {pending ? f.pending : f.submit}
          </button>
          <div className="otp-links">
            <button type="button" className="link-btn" onClick={onResend} disabled={pending || resendLeft > 0}>
              {resendLeft > 0 ? f.resendIn(clock(resendLeft)) : f.resend}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setStep("email");
                setError(null);
                setInfo(null);
                setExpiresAt(null);
              }}
            >
              {f.changeEmail}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
