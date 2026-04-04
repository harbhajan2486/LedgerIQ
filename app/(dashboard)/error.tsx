"use client";

export default function DashboardError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg border border-red-200 p-6">
        <h2 className="text-base font-semibold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-600 mb-4">{error.message}</p>
        {error.digest && (
          <p className="text-xs text-gray-400 font-mono">Digest: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
