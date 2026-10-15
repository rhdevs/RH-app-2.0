import { type JcrcPageModel } from "~/lib/transcript/types";

const SEC_HEADING =
  "mb-0.5 mt-3 break-after-avoid border-b border-black text-xs font-bold uppercase";
const TH = "border-b border-black px-1 py-0.5 text-left font-bold";
const TD = "px-1 py-0.5 align-top";

/**
 * The body of the dedicated JCRC page (JCRC members only).
 *
 * THE SIGNATURE BOXES ARE ALWAYS PLACEHOLDERS: empty boxes with a label and a
 * date placeholder, never a person's name. There is no sign-off flow yet and no
 * stored signature; the real one will replace these boxes in place.
 */
export function JcrcPageBody({ jcrc }: { jcrc: JcrcPageModel }) {
  return (
    <>
      {jcrc.isPlaceholder && (
        <p className="mt-2 text-[10.5px] italic text-neutral-600 print:hidden">
          Placeholder content
        </p>
      )}

      <section>
        <h2 className={SEC_HEADING}>About the Junior Common Room Committee</h2>
        <p className="my-0.5">{jcrc.about}</p>
      </section>

      <section>
        <h2 className={SEC_HEADING}>Role and responsibilities</h2>
        <p className="my-0.5">{jcrc.responsibilities}</p>
      </section>

      <section>
        <h2 className={SEC_HEADING}>Contributions during the year</h2>
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[44%]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Activity
              </th>
              <th scope="col" className={TH}>
                Role
              </th>
              <th scope="col" className={TH}>
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {jcrc.contributions.map((item, index) => (
              <tr key={index} className="break-inside-avoid">
                <td className={TD}>{item.activity}</td>
                <td className={TD}>{item.role}</td>
                <td className={TD}>{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="break-inside-avoid">
        <h2 className={SEC_HEADING}>
          Testimonial from the {jcrc.testimonial.author}
        </h2>
        <blockquote className="my-1 border-l-4 border-black py-1 pl-2.5 text-[12.5px]">
          {jcrc.testimonial.text}
        </blockquote>

        <div className="mt-[34px] grid grid-cols-2 gap-6">
          <SignatureBox
            placeholder="Master signature"
            office="Master, Raffles Hall"
          />
          <SignatureBox
            placeholder="President signature"
            office="President, JCRC"
          />
        </div>
      </section>
    </>
  );
}

function SignatureBox({
  placeholder,
  office,
}: {
  placeholder: string;
  office: string;
}) {
  return (
    <div className="break-inside-avoid border-t border-black pt-0.5 text-[10.5px] text-neutral-600">
      [{placeholder} placeholder]
      <br />
      <b className="text-black">{office}</b>
      <br />
      Date: [placeholder]
    </div>
  );
}
