"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Loader2, ArrowRight, ArrowLeft, Plug, BookOpen, Upload } from "lucide-react";

const STANDARD_ACCOUNTS = [
  { key: "purchase_account",  label: "Purchase Account" },
  { key: "input_igst_18",     label: "Input IGST 18%" },
  { key: "input_igst_12",     label: "Input IGST 12%" },
  { key: "input_igst_5",      label: "Input IGST 5%" },
  { key: "input_cgst",        label: "Input CGST" },
  { key: "input_sgst",        label: "Input SGST" },
  { key: "sundry_creditors",  label: "Sundry Creditors" },
  { key: "tds_payable",       label: "TDS Payable" },
];

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — Tally config
  const [tallyEndpoint, setTallyEndpoint] = useState("http://localhost:9000");
  const [tallyCompany, setTallyCompany] = useState("");
  const [testing, setTesting] = useState(false);
  const [tallyStatus, setTallyStatus] = useState<"idle" | "success" | "error">("idle");

  // Step 2 — Ledger mapping
  const [ledgerMap, setLedgerMap] = useState<Record<string, string>>(
    Object.fromEntries(STANDARD_ACCOUNTS.map((a) => [a.key, ""]))
  );

  async function testTallyConnection() {
    setTesting(true);
    setTallyStatus("idle");
    try {
      const res = await fetch("/api/v1/tally/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: tallyEndpoint }),
      });
      setTallyStatus(res.ok ? "success" : "error");
    } catch {
      setTallyStatus("error");
    }
    setTesting(false);
  }

  async function saveStep1() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/v1/settings/tally", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: tallyEndpoint, companyName: tallyCompany }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error);
      return;
    }
    setStep(2);
  }

  async function saveStep2() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/v1/settings/ledger-mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings: ledgerMap }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error);
      return;
    }
    setStep(3);
  }

  async function finishOnboarding() {
    // Mark onboarding complete and go to upload
    router.push("/upload");
  }

  const steps = [
    { num: 1, label: "Tally Setup",    icon: Plug },
    { num: 2, label: "Ledger Mapping", icon: BookOpen },
    { num: 3, label: "First Upload",   icon: Upload },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Progress */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Welcome to LedgerIQ</h1>
        <div className="flex items-center gap-0">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const done = step > s.num;
            const active = step === s.num;
            return (
              <div key={s.num} className="flex items-center flex-1">
                <div className="flex flex-col items-center">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors
                    ${done ? "bg-green-500 border-green-500" : active ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300"}`}>
                    {done
                      ? <CheckCircle2 size={18} className="text-white" />
                      : <Icon size={16} className={active ? "text-white" : "text-gray-400"} />
                    }
                  </div>
                  <span className={`text-xs mt-1 ${active ? "text-blue-600 font-medium" : done ? "text-green-600" : "text-gray-400"}`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-2 mb-4 ${done ? "bg-green-400" : "bg-gray-200"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">
          {error}
        </div>
      )}

      {/* Step 1 — Tally */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 1 — Connect to Tally</CardTitle>
            <CardDescription>
              Enter your TallyPrime connection details. Tally must be open on this computer or your local network.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Tally endpoint URL</Label>
              <Input
                value={tallyEndpoint}
                onChange={(e) => setTallyEndpoint(e.target.value)}
                placeholder="http://localhost:9000"
              />
              <p className="text-xs text-gray-400">
                Default is http://localhost:9000 — change only if Tally is on a different machine
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Tally company name</Label>
              <Input
                value={tallyCompany}
                onChange={(e) => setTallyCompany(e.target.value)}
                placeholder="e.g. Sharma & Associates Pvt Ltd"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={testTallyConnection} disabled={testing}>
                {testing && <Loader2 size={14} className="mr-2 animate-spin" />}
                Test connection
              </Button>
              {tallyStatus === "success" && (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle2 size={14} /> Connected
                </span>
              )}
              {tallyStatus === "error" && (
                <span className="text-sm text-red-500">
                  Could not connect — make sure Tally is open
                </span>
              )}
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Skip for now
              </Button>
              <Button onClick={saveStep1} disabled={loading}>
                {loading && <Loader2 size={14} className="mr-2 animate-spin" />}
                Save & continue <ArrowRight size={14} className="ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2 — Ledger mapping */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 2 — Map your Tally ledgers</CardTitle>
            <CardDescription>
              Tell LedgerIQ the exact ledger names from your TallyPrime company. This is a one-time setup.
              Type the ledger name exactly as it appears in Tally.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {STANDARD_ACCOUNTS.map((account) => (
              <div key={account.key} className="grid grid-cols-2 gap-4 items-center">
                <Label className="text-sm text-gray-600">{account.label}</Label>
                <Input
                  value={ledgerMap[account.key]}
                  onChange={(e) => setLedgerMap({ ...ledgerMap, [account.key]: e.target.value })}
                  placeholder={`Your Tally name for "${account.label}"`}
                />
              </div>
            ))}

            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft size={14} className="mr-2" /> Back
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(3)}>
                  Skip for now
                </Button>
                <Button onClick={saveStep2} disabled={loading}>
                  {loading && <Loader2 size={14} className="mr-2 animate-spin" />}
                  Save & continue <ArrowRight size={14} className="ml-2" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3 — First upload */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 3 — Upload your first document</CardTitle>
            <CardDescription>
              You're all set! Upload your first invoice or bank statement and watch LedgerIQ read it automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                { emoji: "📄", label: "Upload an invoice", desc: "PDF or image" },
                { emoji: "🤖", label: "AI reads it", desc: "Fields extracted automatically" },
                { emoji: "✅", label: "You review", desc: "Correct any mistakes" },
              ].map((item) => (
                <div key={item.label} className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-2xl mb-2">{item.emoji}</div>
                  <div className="text-sm font-medium text-gray-900">{item.label}</div>
                  <div className="text-xs text-gray-500 mt-1">{item.desc}</div>
                </div>
              ))}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft size={14} className="mr-2" /> Back
              </Button>
              <Button onClick={finishOnboarding}>
                Go to Upload <ArrowRight size={14} className="ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-gray-400">
        You can update all these settings anytime from the Settings page.
      </p>
    </div>
  );
}
