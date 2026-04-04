export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-28 bg-gray-200 rounded-lg animate-pulse" />
        ))}
      </div>
      <div className="h-48 bg-gray-200 rounded-lg animate-pulse" />
    </div>
  );
}
