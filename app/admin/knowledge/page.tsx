"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Brain, CheckCircle2, XCircle, Clock, Shield, Users, Plus, X } from "lucide-react";

interface PendingRule {
  id: string;
  rule_type: string;
  pattern: Record<string, unknown>;
  action: Record<string, unknown>;
  confidence: number;
  tenant_count: number;
  example_tenants: string[];
  created_at: string;
}

interface Layer1Rule {
  id: string;
  rule_type: string;
  pattern: Record<string, unknown>;
  action: Record<string, unknown>;
  source: string;
  confidence: number;
}

interface Layer3Summary {
  tenant_count: number;
  total_vendor_profiles: number;
  total_corrections: number;
  top_trained_tenants: Array<{ tenant_name: string; profile_count: number; correction_count: number }>;
}

const RULE_TYPE_LABELS: Record<string, string> = {
  tds_section: "TDS Section",
  sac_gst_rate: "GST Rate (SAC)",
  hsn_gst_rate: "GST Rate (HSN)",
  reverse_charge: "Reverse Charge (RCM)",
  matching_heuristic: "Invoice Matching",
  itc_eligibility: "ITC Eligibility",
  field_pattern: "Field extraction pattern",
  vendor_mapping: "Vendor name mapping",
  gst_rate: "GST rate correction",
  date_format: "Date format",
  amount_format: "Amount format",
};

export default function AdminKnowledgePage() {
  const [pending, setPending] = useState<PendingRule[]>([]);
  const [layer1, setLayer1] = useState<Layer1Rule[]>([]);
  const [layer3, setLayer3] = useState<Layer3Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [approvedCount, setApprovedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [activeTab, setActiveTab] = useState<"layer1" | "layer2" | "layer3">("layer2");
  const [showAddRule, setShowAddRule] = useState(false);
  const [addRuleForm, setAddRuleForm] = useState({ rule_type: "tds_section", section: "", description: "", keywords: "", rate: "", threshold: "", source_ref: "" });
  const [addRuleLoading, setAddRuleLoading] = useState(false);
  const [addRuleError, setAddRuleError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/admin/knowledge").then((r) => r.json()),
      fetch("/api/v1/admin/knowledge/layer1").then((r) => r.json()),
      fetch("/api/v1/admin/knowledge/layer3").then((r) => r.json()),
    ]).then(([l2data, l1data, l3data]) => {
      setPending(l2data.pending ?? []);
      setLayer1(l1data.rules ?? []);
      setLayer3(l3data ?? null);
    }).finally(() => setLoading(false));
  }, []);

  async function handleAction(ruleId: string, action: "approve" | "reject") {
    setActioningId(ruleId);
    try {
      const res = await fetch(`/api/v1/admin/knowledge/${ruleId}/${action}`, { method: "POST" });
      if (res.ok) {
        setPending((prev) => prev.filter((r) => r.id !== ruleId));
        if (action === "approve") setApprovedCount((n) => n + 1);
        else setRejectedCount((n) => n + 1);
      }
    } finally {
      setActioningId(null);
    }
  }

  async function addRule() {
    setAddRuleLoading(true);
    setAddRuleError("");
    try {
      const res = await fetch("/api/v1/admin/knowledge/layer1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rule_type: addRuleForm.rule_type,
          section: addRuleForm.section,
          description: addRuleForm.description,
          keywords: addRuleForm.keywords,
          rate: addRuleForm.rate ? parseFloat(addRuleForm.rate) : undefined,
          threshold: addRuleForm.threshold ? parseFloat(addRuleForm.threshold) : undefined,
          source_ref: addRuleForm.source_ref,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setAddRuleError(data.error ?? "Failed"); return; }
      // Refresh layer1
      const l1 = await fetch("/api/v1/admin/knowledge/layer1").then((r) => r.json());
      setLayer1(l1.rules ?? []);
      setShowAddRule(false);
      setAddRuleForm({ rule_type: "tds_section", section: "", description: "", keywords: "", rate: "", threshold: "", source_ref: "" });
    } finally {
      setAddRuleLoading(false);
    }
  }

  const tabs = [
    { id: "layer1" as const, label: "Layer 1 — National Rules", icon: Shield, count: layer1.length, colour: "text-blue-600" },
    { id: "layer2" as const, label: "Layer 2 — Crowd Rules",    icon: Users,  count: pending.length, colour: "text-yellow-600" },
    { id: "layer3" as const, label: "Layer 3 — Firm Memory",    icon: Brain,  count: layer3?.total_vendor_profiles ?? 0, colour: "text-green-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Brain className="w-6 h-6" /> Knowledge Base
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Three layers of intelligence powering LedgerIQ's accuracy. Layer 3 always wins over Layer 2, which wins over Layer 1.
        </p>
      </div>

      {/* Training Score Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-blue-200 bg-blue-50/30">
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-2">
              <Shield size={16} className="text-blue-600" />
              <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Layer 1 — National</span>
            </div>
            <p className="text-3xl font-bold text-blue-700">{layer1.length}</p>
            <p className="text-xs text-blue-600 mt-1">Global tax rules (law-based)</p>
            <div className="mt-2 w-full bg-blue-100 rounded-full h-1.5">
              <div className="bg-blue-500 h-1.5 rounded-full w-full" />
            </div>
            <p className="text-xs text-blue-500 mt-1">100% — pre-loaded, never changes automatically</p>
          </CardContent>
        </Card>

        <Card className="border-yellow-200 bg-yellow-50/30">
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-yellow-600" />
              <span className="text-xs font-semibold text-yellow-700 uppercase tracking-wide">Layer 2 — Crowd</span>
            </div>
            <p className="text-3xl font-bold text-yellow-700">{pending.length}</p>
            <p className="text-xs text-yellow-600 mt-1">Patterns pending your review</p>
            <div className="mt-2 w-full bg-yellow-100 rounded-full h-1.5">
              <div className="bg-yellow-500 h-1.5 rounded-full" style={{ width: pending.length > 0 ? "60%" : "0%" }} />
            </div>
            <p className="text-xs text-yellow-500 mt-1">{approvedCount} approved this session</p>
          </CardContent>
        </Card>

        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-2">
              <Brain size={16} className="text-green-600" />
              <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">Layer 3 — Firm Memory</span>
            </div>
            <p className="text-3xl font-bold text-green-700">{layer3?.total_vendor_profiles ?? 0}</p>
            <p className="text-xs text-green-600 mt-1">Vendor profiles trained across {layer3?.tenant_count ?? 0} firms</p>
            <div className="mt-2 w-full bg-green-100 rounded-full h-1.5">
              <div
                className="bg-green-500 h-1.5 rounded-full"
                style={{ width: layer3 && layer3.total_vendor_profiles > 0 ? `${Math.min((layer3.total_vendor_profiles / 50) * 100, 100)}%` : "0%" }}
              />
            </div>
            <p className="text-xs text-green-500 mt-1">{layer3?.total_corrections ?? 0} corrections recorded</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-0" aria-label="Knowledge layers">
          {tabs.map(({ id, label, icon: Icon, count, colour }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === id
                  ? `border-blue-600 text-blue-700`
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <Icon size={14} className={activeTab === id ? colour : "text-gray-400"} />
              {label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === id ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                {count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {/* LAYER 1 */}
          {activeTab === "layer1" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  These rules come from Indian tax law (CGST Act, Income Tax Act). They apply to every firm from day one. Only a super-admin can add or modify them.
                </p>
                <button
                  onClick={() => setShowAddRule(true)}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 shrink-0 ml-4"
                >
                  <Plus className="w-3 h-3" /> Add Rule
                </button>
              </div>

              {/* Add Rule Modal */}
              {showAddRule && (
                <Card className="border-blue-300 bg-blue-50/30">
                  <CardHeader className="py-3 px-4 border-b flex-row items-center justify-between">
                    <CardTitle className="text-sm text-blue-700">Add New Global Rule (Layer 1)</CardTitle>
                    <button onClick={() => setShowAddRule(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                  </CardHeader>
                  <CardContent className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">Rule Type</label>
                        <select
                          value={addRuleForm.rule_type}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, rule_type: e.target.value }))}
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        >
                          <option value="tds_section">TDS Section</option>
                          <option value="sac_gst_rate">GST Rate (SAC)</option>
                          <option value="hsn_gst_rate">GST Rate (HSN)</option>
                          <option value="reverse_charge">Reverse Charge (RCM)</option>
                          <option value="itc_eligibility">ITC Eligibility</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">Section / Code *</label>
                        <input
                          value={addRuleForm.section}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, section: e.target.value }))}
                          placeholder="e.g. 194J, 9983"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-medium text-gray-600 block mb-1">Description</label>
                        <input
                          value={addRuleForm.description}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, description: e.target.value }))}
                          placeholder="e.g. Professional or technical services"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-medium text-gray-600 block mb-1">Keywords (comma-separated)</label>
                        <input
                          value={addRuleForm.keywords}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, keywords: e.target.value }))}
                          placeholder="e.g. consultant, advisory, legal, doctor"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">Rate (%)</label>
                        <input
                          type="number"
                          value={addRuleForm.rate}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, rate: e.target.value }))}
                          placeholder="e.g. 10"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">Threshold (₹)</label>
                        <input
                          type="number"
                          value={addRuleForm.threshold}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, threshold: e.target.value }))}
                          placeholder="e.g. 30000"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-medium text-gray-600 block mb-1">Legal Reference / Source</label>
                        <input
                          value={addRuleForm.source_ref}
                          onChange={(e) => setAddRuleForm((f) => ({ ...f, source_ref: e.target.value }))}
                          placeholder="e.g. Income Tax Act 1961, Section 194J"
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                        />
                      </div>
                    </div>
                    {addRuleError && <p className="text-xs text-red-600">{addRuleError}</p>}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={addRule}
                        disabled={addRuleLoading || !addRuleForm.section}
                        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addRuleLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Add to Global Rules
                      </button>
                      <button onClick={() => setShowAddRule(false)} className="text-xs text-gray-500 hover:text-gray-700 px-2">Cancel</button>
                    </div>
                  </CardContent>
                </Card>
              )}
              {layer1.length === 0 ? (
                <Card><CardContent className="py-8 text-center text-sm text-gray-400">No Layer 1 rules loaded yet. Run migration 007 in Supabase SQL editor.</CardContent></Card>
              ) : (
                <div className="space-y-2">
                  {Object.entries(
                    layer1.reduce((acc, rule) => {
                      const type = RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type;
                      if (!acc[type]) acc[type] = [];
                      acc[type].push(rule);
                      return acc;
                    }, {} as Record<string, Layer1Rule[]>)
                  ).map(([type, rules]) => (
                    <Card key={type}>
                      <CardHeader className="py-3 px-4 border-b">
                        <CardTitle className="text-sm text-gray-700 flex items-center justify-between">
                          {type}
                          <Badge variant="secondary" className="text-xs">{rules.length} rules</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <table className="w-full text-xs">
                          <tbody>
                            {rules.map((rule) => (
                              <tr key={rule.id} className="border-b last:border-0 hover:bg-gray-50">
                                <td className="px-4 py-2 font-mono text-gray-600 w-1/3">
                                  {JSON.stringify(rule.pattern).slice(0, 80)}
                                </td>
                                <td className="px-4 py-2 text-gray-500 w-1/3">
                                  {JSON.stringify(rule.action).slice(0, 80)}
                                </td>
                                <td className="px-4 py-2 text-gray-400 text-right">
                                  {rule.source}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* LAYER 2 */}
          {activeTab === "layer2" && (
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="flex items-center gap-2 text-sm text-yellow-700 bg-yellow-50 px-3 py-2 rounded-md">
                  <Clock className="w-4 h-4" /><span>{pending.length} pending review</span>
                </div>
                {approvedCount > 0 && (
                  <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-2 rounded-md">
                    <CheckCircle2 className="w-4 h-4" /><span>{approvedCount} approved this session</span>
                  </div>
                )}
                {rejectedCount > 0 && (
                  <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md">
                    <XCircle className="w-4 h-4" /><span>{rejectedCount} rejected this session</span>
                  </div>
                )}
              </div>

              {pending.length === 0 ? (
                <Card>
                  <CardContent className="pt-12 pb-12 text-center">
                    <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
                    <p className="text-gray-700 font-medium">All caught up!</p>
                    <p className="text-sm text-gray-500 mt-1">No patterns waiting. When 10+ firms share the same correction, it will appear here.</p>
                  </CardContent>
                </Card>
              ) : (
                pending.map((rule) => (
                  <Card key={rule.id} className="border-l-4 border-l-yellow-400">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-base">{RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}</CardTitle>
                          <CardDescription className="mt-1">
                            Spotted in <strong>{rule.tenant_count} firms</strong> —{" "}
                            {rule.example_tenants.slice(0, 3).join(", ")}
                            {rule.tenant_count > 3 ? ` and ${rule.tenant_count - 3} more` : ""}
                          </CardDescription>
                        </div>
                        <Badge variant="secondary" className="text-xs">{(rule.confidence * 100).toFixed(0)}% confidence</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-gray-50 rounded-md p-3">
                          <p className="text-xs font-medium text-gray-500 mb-1">Pattern (what was seen)</p>
                          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono">{JSON.stringify(rule.pattern, null, 2)}</pre>
                        </div>
                        <div className="bg-blue-50 rounded-md p-3">
                          <p className="text-xs font-medium text-blue-600 mb-1">Action (what to do)</p>
                          <pre className="text-xs text-blue-700 whitespace-pre-wrap font-mono">{JSON.stringify(rule.action, null, 2)}</pre>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 pt-1">
                        <button
                          onClick={() => handleAction(rule.id, "approve")}
                          disabled={actioningId === rule.id}
                          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {actioningId === rule.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                          Approve — add to global rules
                        </button>
                        <button
                          onClick={() => handleAction(rule.id, "reject")}
                          disabled={actioningId === rule.id}
                          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          <XCircle className="w-3 h-3" /> Reject
                        </button>
                        <span className="text-xs text-gray-400 ml-auto">
                          {new Date(rule.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          )}

          {/* LAYER 3 */}
          {activeTab === "layer3" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Each firm trains Layer 3 through their own corrections. After 3 corrections for the same vendor+field, the system learns and auto-fills future invoices from that vendor.
              </p>
              {!layer3 || layer3.tenant_count === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-gray-400">
                    No vendor profiles trained yet. Layer 3 builds up as firms correct extractions.
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { label: "Firms with trained profiles", value: layer3.tenant_count },
                      { label: "Vendor profiles trained",     value: layer3.total_vendor_profiles },
                      { label: "Total corrections recorded",  value: layer3.total_corrections },
                    ].map(({ label, value }) => (
                      <Card key={label}>
                        <CardContent className="py-4 px-4">
                          <p className="text-xs text-gray-500">{label}</p>
                          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {layer3.top_trained_tenants.length > 0 && (
                    <Card>
                      <CardHeader className="py-3 px-4 border-b">
                        <CardTitle className="text-sm text-gray-700">Most trained firms</CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b bg-gray-50">
                              <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Firm</th>
                              <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Vendor profiles</th>
                              <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Corrections</th>
                              <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Training score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {layer3.top_trained_tenants.map((t) => {
                              const score = Math.min(Math.round((t.correction_count / 50) * 100), 100);
                              return (
                                <tr key={t.tenant_name} className="border-b last:border-0">
                                  <td className="px-4 py-2 font-medium text-gray-800">{t.tenant_name}</td>
                                  <td className="px-4 py-2 text-gray-600">{t.profile_count}</td>
                                  <td className="px-4 py-2 text-gray-600">{t.correction_count}</td>
                                  <td className="px-4 py-2">
                                    <div className="flex items-center gap-2">
                                      <div className="w-24 bg-gray-100 rounded-full h-1.5">
                                        <div
                                          className="bg-green-500 h-1.5 rounded-full"
                                          style={{ width: `${score}%` }}
                                        />
                                      </div>
                                      <span className="text-xs text-gray-500">{score}%</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
