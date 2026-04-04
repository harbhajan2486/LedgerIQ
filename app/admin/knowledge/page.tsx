"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Brain, CheckCircle2, XCircle, Clock } from "lucide-react";

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

export default function AdminKnowledgePage() {
  const [pending, setPending] = useState<PendingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [approvedCount, setApprovedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);

  useEffect(() => {
    fetch("/api/v1/admin/knowledge")
      .then((r) => r.json())
      .then((d) => setPending(d.pending ?? []))
      .finally(() => setLoading(false));
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

  const RULE_TYPE_LABELS: Record<string, string> = {
    field_pattern: "Field extraction pattern",
    vendor_mapping: "Vendor name mapping",
    gst_rate: "GST rate correction",
    tds_section: "TDS section",
    date_format: "Date format",
    amount_format: "Amount format",
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Brain className="w-6 h-6" /> Knowledge Base — Layer 2 Approvals
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Patterns spotted in 10+ firms are promoted here for your review before going global.
          Approving a rule makes it available to all firms immediately.
        </p>
      </div>

      {/* Stats */}
      <div className="flex gap-4">
        <div className="flex items-center gap-2 text-sm text-yellow-700 bg-yellow-50 px-3 py-2 rounded-md">
          <Clock className="w-4 h-4" />
          <span>{pending.length} pending review</span>
        </div>
        {approvedCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-2 rounded-md">
            <CheckCircle2 className="w-4 h-4" />
            <span>{approvedCount} approved this session</span>
          </div>
        )}
        {rejectedCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md">
            <XCircle className="w-4 h-4" />
            <span>{rejectedCount} rejected this session</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      ) : pending.length === 0 ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
            <p className="text-gray-700 font-medium">All caught up!</p>
            <p className="text-sm text-gray-500 mt-1">
              No patterns waiting for review. When 10+ firms share a pattern, it will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pending.map((rule) => (
            <Card key={rule.id} className="border-l-4 border-l-yellow-400">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Spotted in <strong>{rule.tenant_count} firms</strong> —{" "}
                      {rule.example_tenants.slice(0, 3).join(", ")}
                      {rule.tenant_count > 3 ? ` and ${rule.tenant_count - 3} more` : ""}
                    </CardDescription>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {(rule.confidence * 100).toFixed(0)}% confidence
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-gray-50 rounded-md p-3">
                    <p className="text-xs font-medium text-gray-500 mb-1">Pattern (what was seen)</p>
                    <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono">
                      {JSON.stringify(rule.pattern, null, 2)}
                    </pre>
                  </div>
                  <div className="bg-blue-50 rounded-md p-3">
                    <p className="text-xs font-medium text-blue-600 mb-1">Action (what to do)</p>
                    <pre className="text-xs text-blue-700 whitespace-pre-wrap font-mono">
                      {JSON.stringify(rule.action, null, 2)}
                    </pre>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <Button
                    size="sm"
                    onClick={() => handleAction(rule.id, "approve")}
                    disabled={actioningId === rule.id}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {actioningId === rule.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <><CheckCircle2 className="w-3 h-3 mr-1" /> Approve — add to global rules</>
                    }
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAction(rule.id, "reject")}
                    disabled={actioningId === rule.id}
                    className="text-red-600 border-red-200 hover:bg-red-50"
                  >
                    <XCircle className="w-3 h-3 mr-1" /> Reject
                  </Button>
                  <span className="text-xs text-gray-400 ml-auto">
                    Submitted {new Date(rule.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
