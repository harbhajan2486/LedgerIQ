"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Save, RotateCcw, Bot, Thermometer, SlidersHorizontal, FileText, DollarSign, Info } from "lucide-react";
import { toast } from "sonner";
import type { AiConfig } from "@/app/api/v1/admin/ai-config/route";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  note: "Fast & cheap — ~$0.80/1M input tokens"  },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", note: "Balanced — ~$3/1M input tokens"         },
  { id: "claude-opus-4-6",           label: "Claude Opus 4.6",   note: "Most capable — ~$15/1M input tokens"   },
];

function Slider({ label, value, min, max, step, onChange, hint }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <span className="text-sm font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
          {value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-600"
      />
      <div className="flex justify-between text-xs text-gray-400 mt-0.5">
        <span>{min}</span>
        {hint && <span className="text-gray-500 italic">{hint}</span>}
        <span>{max}</span>
      </div>
    </div>
  );
}

export default function AiConfigPage() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<"models" | "params" | "prompts" | "budget">("models");

  useEffect(() => {
    fetch("/api/v1/admin/ai-config")
      .then(r => r.json())
      .then(d => setConfig(d.config))
      .finally(() => setLoading(false));
  }, []);

  function update<K extends keyof AiConfig>(key: K, value: AiConfig[K]) {
    setConfig(prev => prev ? { ...prev, [key]: value } : prev);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    const res = await fetch("/api/v1/admin/ai-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    setSaving(false);
    if (res.ok) {
      toast.success("AI configuration saved. New extractions will use these settings.");
    } else {
      toast.error(data.error ?? "Save failed");
    }
  }

  async function resetToDefaults() {
    if (!confirm("Reset all AI settings to factory defaults?")) return;
    const res = await fetch("/api/v1/admin/ai-config");
    const data = await res.json();
    setConfig(data.config);
    toast.info("Reset to defaults — click Save to apply.");
  }

  const SECTIONS = [
    { id: "models",  label: "Models",      icon: <Bot size={14} /> },
    { id: "params",  label: "Parameters",  icon: <SlidersHorizontal size={14} /> },
    { id: "prompts", label: "Prompts",     icon: <FileText size={14} /> },
    { id: "budget",  label: "Budget",      icon: <DollarSign size={14} /> },
  ] as const;

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 py-12">
      <Loader2 className="w-5 h-5 animate-spin" /> Loading AI config…
    </div>
  );

  if (!config) return <p className="text-red-500 text-sm">Failed to load config.</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-600" /> AI Configurator
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Control models, generation parameters, prompt templates, and cost limits.
            Changes apply to all new extractions immediately.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={resetToDefaults}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">
            <RotateCcw size={14} /> Reset defaults
          </button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save config
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeSection === s.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* ─── MODELS ─────────────────────────────────────────────────── */}
      {activeSection === "models" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Default Model (First attempt)</CardTitle>
              <p className="text-sm text-gray-500">Used for every extraction. Cheaper, faster. Upgrades automatically if confidence is low.</p>
            </CardHeader>
            <CardContent className="space-y-2">
              {MODELS.map((m) => (
                <label key={m.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    config.default_model === m.id
                      ? "border-blue-400 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}>
                  <input type="radio" name="default_model" value={m.id}
                    checked={config.default_model === m.id}
                    onChange={() => update("default_model", m.id as AiConfig["default_model"])}
                    className="mt-1 accent-blue-600" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{m.label}</p>
                    <p className="text-xs text-gray-500">{m.note}</p>
                  </div>
                </label>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upgrade Model (Fallback)</CardTitle>
              <p className="text-sm text-gray-500">
                Used when default model avg confidence falls below{" "}
                <span className="font-semibold text-orange-600">{Math.round(config.confidence_upgrade_threshold * 100)}%</span>.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {MODELS.filter(m => m.id !== "claude-haiku-4-5-20251001").map((m) => (
                <label key={m.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    config.upgrade_model === m.id
                      ? "border-orange-400 bg-orange-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}>
                  <input type="radio" name="upgrade_model" value={m.id}
                    checked={config.upgrade_model === m.id}
                    onChange={() => update("upgrade_model", m.id as AiConfig["upgrade_model"])}
                    className="mt-1 accent-orange-500" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{m.label}</p>
                    <p className="text-xs text-gray-500">{m.note}</p>
                  </div>
                </label>
              ))}
              <Slider
                label="Confidence upgrade threshold"
                value={config.confidence_upgrade_threshold}
                min={0.3} max={0.95} step={0.05}
                onChange={(v) => update("confidence_upgrade_threshold", v)}
                hint="below this → switch to upgrade model"
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── GENERATION PARAMETERS ──────────────────────────────────── */}
      {activeSection === "params" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Thermometer size={16} className="text-red-500" /> Temperature
              </CardTitle>
              <p className="text-sm text-gray-500">
                Controls randomness. <strong>Lower = more deterministic</strong> (recommended for structured extraction).
                Keep at 0.0–0.2 for invoices.
              </p>
            </CardHeader>
            <CardContent>
              <Slider
                label="Temperature"
                value={config.temperature}
                min={0} max={1} step={0.05}
                onChange={(v) => update("temperature", v)}
                hint="0 = fully deterministic · 1 = very creative"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top-p (Nucleus Sampling)</CardTitle>
              <p className="text-sm text-gray-500">
                Controls diversity by limiting which tokens the model considers. <strong>0.9–1.0 recommended</strong> — lower values can make responses too conservative and cause the model to miss fields.
              </p>
            </CardHeader>
            <CardContent>
              <Slider
                label="Top-p"
                value={config.top_p}
                min={0.1} max={1} step={0.05}
                onChange={(v) => update("top_p", v)}
                hint="0.1 = very focused · 1.0 = full distribution"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Max Output Tokens</CardTitle>
              <p className="text-sm text-gray-500">
                Maximum tokens in AI response. The JSON output for a full invoice is typically 600–900 tokens.
                Set higher if you see truncated responses.
              </p>
            </CardHeader>
            <CardContent>
              <Slider
                label="Max tokens"
                value={config.max_tokens}
                min={500} max={4096} step={100}
                onChange={(v) => update("max_tokens", v)}
                hint="600–1200 is sufficient · higher = marginally more expensive"
              />
            </CardContent>
          </Card>

          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700 flex items-start gap-2">
            <Info size={14} className="flex-shrink-0 mt-0.5" />
            <p>
              <strong>Recommended for invoice extraction:</strong> Temperature 0.1 · Top-p 0.95 · Max tokens 1500.
              These settings balance accuracy with cost. Only change if you are seeing specific extraction issues.
            </p>
          </div>
        </div>
      )}

      {/* ─── PROMPT TEMPLATES ───────────────────────────────────────── */}
      {activeSection === "prompts" && (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700 flex items-start gap-2">
            <Info size={14} className="flex-shrink-0 mt-0.5" />
            <div>
              <p><strong>Placeholders you can use:</strong></p>
              <ul className="mt-1 space-y-0.5">
                <li><code className="font-mono bg-blue-100 px-1 rounded">{"{INJECTIONS}"}</code> — replaced with few-shot examples + Layer 1 tax rules + Layer 3 vendor profiles</li>
                <li><code className="font-mono bg-blue-100 px-1 rounded">{"{DOC_TYPE}"}</code> — replaced with the document type (purchase invoice, expense, etc.)</li>
              </ul>
              <p className="mt-1">Both placeholders are required. Do not remove them.</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">System Prompt</CardTitle>
              <p className="text-sm text-gray-500">Sets the AI&apos;s role and rules. Injected at the start of every extraction call.</p>
            </CardHeader>
            <CardContent>
              <textarea
                value={config.system_prompt}
                onChange={(e) => update("system_prompt", e.target.value)}
                rows={16}
                className="w-full text-sm font-mono px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
              <p className="text-xs text-gray-400 mt-1">
                {config.system_prompt.length} characters
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">User Prompt Template</CardTitle>
              <p className="text-sm text-gray-500">The actual extraction request. <code className="font-mono text-xs bg-gray-100 px-1 rounded">{"{DOC_TYPE}"}</code> is replaced with the document type at runtime.</p>
            </CardHeader>
            <CardContent>
              <textarea
                value={config.user_prompt}
                onChange={(e) => update("user_prompt", e.target.value)}
                rows={30}
                className="w-full text-sm font-mono px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
              <p className="text-xs text-gray-400 mt-1">
                {config.user_prompt.length} characters
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── BUDGET ─────────────────────────────────────────────────── */}
      {activeSection === "budget" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly AI Budget</CardTitle>
              <p className="text-sm text-gray-500">
                Hard limit on total AI spend across all tenants per calendar month. When reached, new documents
                are queued (not failed) and processed when the next month begins.
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <label className="text-sm font-medium text-gray-700">Monthly budget (USD)</label>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-gray-500 text-sm">$</span>
                  <input
                    type="number" min={5} max={500} step={5}
                    value={config.monthly_budget_usd}
                    onChange={(e) => update("monthly_budget_usd", parseFloat(e.target.value) || 50)}
                    className="w-32 text-sm px-3 py-1.5 rounded border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <span className="text-xs text-gray-400">per month, all tenants combined</span>
                </div>
              </div>

              <Slider
                label="Alert threshold (%)"
                value={config.alert_threshold_pct}
                min={50} max={99} step={5}
                onChange={(v) => update("alert_threshold_pct", v)}
                hint={`alert sent when spend hits $${((config.monthly_budget_usd * config.alert_threshold_pct) / 100).toFixed(0)}`}
              />

              <div className="grid grid-cols-3 gap-3 pt-2">
                {[
                  { label: "~1,000 invoices (Haiku)",  cost: 1000 * 0.002 },
                  { label: "~1,000 invoices (Sonnet)", cost: 1000 * 0.008 },
                  { label: "~1,000 invoices (Opus)",   cost: 1000 * 0.035 },
                ].map((e) => (
                  <div key={e.label} className="p-3 rounded-lg bg-gray-50 border border-gray-100 text-center">
                    <p className="text-xs text-gray-500">{e.label}</p>
                    <p className="text-lg font-bold text-gray-900 mt-1">${e.cost.toFixed(2)}</p>
                    <p className="text-xs text-gray-400">{Math.floor(config.monthly_budget_usd / e.cost).toLocaleString()} invoices / budget</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
