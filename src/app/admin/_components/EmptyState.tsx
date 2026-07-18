export default function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {hint && <p className="max-w-md text-sm text-gray-500">{hint}</p>}
      {action}
    </div>
  );
}
