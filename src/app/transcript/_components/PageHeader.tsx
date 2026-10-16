import Image from "next/image";

/** Source of the crest on every page of the transcript. */
export const CREST = {
  src: "/transcript/rh-crest.png",
  alt: "Raffles Hall crest",
  /** 604:694, so 48px high is about 42px wide. */
  width: 42,
  height: 48,
} as const;

/**
 * The Raffles Hall crest. A real <img> (never a CSS background) so it survives
 * printing, loaded eagerly so a page further down is not skipped when printing
 * before it has scrolled into view.
 */
export function Crest() {
  return (
    <Image
      src={CREST.src}
      alt={CREST.alt}
      width={CREST.width}
      height={CREST.height}
      loading="eager"
      className="h-12 w-auto shrink-0"
    />
  );
}

/**
 * Top of every transcript page: crest at the left, then the page title.
 */
export function PageHeader({
  title,
  subtitle,
  level = "h2",
}: {
  title: string;
  subtitle?: string;
  level?: "h1" | "h2";
}) {
  const Heading = level;
  return (
    <header className="flex items-start justify-between border-b-2 border-black pb-1.5">
      <div className="flex items-center gap-2.5">
        <Crest />
        <div>
          <Heading className="m-0 text-[19px] font-bold uppercase leading-tight tracking-[0.06em]">
            {title}
          </Heading>
          {subtitle && (
            <p className="m-0 text-[11px] text-neutral-600">{subtitle}</p>
          )}
        </div>
      </div>
    </header>
  );
}

/** The row of labelled facts under a page header. */
export function MetaRow({
  items,
}: {
  items: Array<{ label: string; value: string; detail?: string }>;
}) {
  return (
    <dl className="mb-2.5 mt-2 grid grid-cols-2 gap-1.5 text-[10.5px] sm:grid-cols-5">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="font-bold uppercase text-neutral-600">{item.label}</dt>
          <dd className="m-0 break-words text-xs font-bold">
            {item.value}
            {item.detail && (
              <span className="block text-[10.5px] font-normal text-neutral-600">
                {item.detail}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
