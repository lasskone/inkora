interface PagePlaceholderProps {
  title: string;
  description: string;
}

/**
 * Shared placeholder state for the future primary screens.
 *
 * The navigation and routing structure is established in the application
 * foundation task; the business features themselves are implemented later.
 */
export function PagePlaceholder({ title, description }: PagePlaceholderProps) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted max-w-2xl">{description}</p>
      <p className="inline-flex w-fit rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-muted">
        Implementation pending
      </p>
    </div>
  );
}
