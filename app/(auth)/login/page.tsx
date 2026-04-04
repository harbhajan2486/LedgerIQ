"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Eye, EyeOff, Loader2 } from "lucide-react";

type Step = "credentials" | "mfa" | "forgot";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // Check if MFA is required
    if (data.session?.user) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.[0];

      if (totpFactor && totpFactor.status === "verified") {
        // MFA enrolled — challenge it
        const { data: challengeData, error: challengeError } =
          await supabase.auth.mfa.challenge({ factorId: totpFactor.id });

        if (challengeError) {
          setError(challengeError.message);
          setLoading(false);
          return;
        }

        setMfaFactorId(totpFactor.id);
        setMfaChallengeId(challengeData.id);
        setStep("mfa");
        setLoading(false);
        return;
      }
    }

    router.push("/dashboard");
    router.refresh();
  }

  async function handleMFA(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaFactorId || !mfaChallengeId) return;
    setError(null);
    setLoading(true);

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: mfaChallengeId,
      code: mfaCode,
    });

    if (verifyError) {
      setError("Invalid code. Please try again.");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });

    setLoading(false);
    if (resetError) {
      setError(resetError.message);
    } else {
      setMessage("Check your email for a password reset link.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="text-center">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">LQ</span>
            </div>
            <span className="text-2xl font-semibold text-gray-900">LedgerIQ</span>
          </div>
          <p className="text-sm text-gray-500">AI-powered accounting for India</p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">
              {step === "credentials" && "Sign in to your account"}
              {step === "mfa" && "Two-factor authentication"}
              {step === "forgot" && "Reset your password"}
            </CardTitle>
            <CardDescription>
              {step === "mfa" && "Enter the 6-digit code from your authenticator app"}
              {step === "forgot" && "We'll send a reset link to your email"}
            </CardDescription>
          </CardHeader>

          <CardContent>
            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">
                {error}
              </div>
            )}
            {message && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-md">
                {message}
              </div>
            )}

            {/* Credentials step */}
            {step === "credentials" && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@firm.com"
                    required
                    autoComplete="email"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                  Sign in
                </Button>

                <button
                  type="button"
                  onClick={() => { setStep("forgot"); setError(null); }}
                  className="w-full text-sm text-blue-600 hover:underline text-center"
                >
                  Forgot password?
                </button>
              </form>
            )}

            {/* MFA step */}
            {step === "mfa" && (
              <form onSubmit={handleMFA} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa">Authentication code</Label>
                  <Input
                    id="mfa"
                    type="text"
                    inputMode="numeric"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    required
                    maxLength={6}
                    autoFocus
                    className="text-center text-xl tracking-widest"
                  />
                </div>

                <Button type="submit" className="w-full" disabled={loading || mfaCode.length !== 6}>
                  {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                  Verify
                </Button>

                <button
                  type="button"
                  onClick={() => { setStep("credentials"); setMfaCode(""); setError(null); }}
                  className="w-full text-sm text-gray-500 hover:underline text-center"
                >
                  Back to sign in
                </button>
              </form>
            )}

            {/* Forgot password step */}
            {step === "forgot" && (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="reset-email">Email address</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@firm.com"
                    required
                  />
                </div>

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                  Send reset link
                </Button>

                <button
                  type="button"
                  onClick={() => { setStep("credentials"); setError(null); setMessage(null); }}
                  className="w-full text-sm text-gray-500 hover:underline text-center"
                >
                  Back to sign in
                </button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-gray-400">
          LedgerIQ · Confidential · All data encrypted
        </p>
      </div>
    </div>
  );
}
