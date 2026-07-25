"use client";

import { useEffect } from "react";
import Image from "next/image";
import Header from "../_components/header";

// Public, read-only showcase of everything new in the RHApp. Exempt from
// MatricGate (see its ALLOW_LIST) so anyone — signed in or not — can read it.
// All styles are scoped under `.wn` so they can't collide with the app's
// global Tailwind/shadcn CSS, and the page commits to a single light "hall
// paper" identity to sit consistently inside the otherwise light app chrome.

const styles = `
.wn {
  --paper: #F4F5F2;
  --surface: #FBFBF9;
  --surface-2: #EFF1EC;
  --ink: #16231C;
  --ink-soft: #3C4A42;
  --muted: #6B7A70;
  --line: #DCE0D8;
  --green: #1F4D3A;
  --green-bright: #2C6B4F;
  --brass: #B5811F;
  --brass-soft: #C99A3A;
  --wn-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --wn-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --maxw: 1080px;

  background: var(--paper);
  color: var(--ink);
  font-family: var(--wn-sans);
  font-size: 17px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  padding-bottom: 4.5rem;
}

.wn .wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 clamp(1.2rem, 5vw, 3rem); }

/* Hero */
.wn .hero { position: relative; overflow: hidden; border-bottom: 1px solid var(--line); }
.wn .hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 90% at 82% -10%, color-mix(in srgb, var(--green) 16%, transparent), transparent 60%),
    radial-gradient(90% 70% at 8% 120%, color-mix(in srgb, var(--brass) 12%, transparent), transparent 55%);
}
.wn .hero-inner { position: relative; padding: clamp(3rem, 8vw, 6rem) 0 clamp(2.5rem, 6vw, 4.5rem); display: grid; gap: 1.6rem; justify-items: start; }
.wn .brandmark { display: block; height: 54px; width: auto; flex: none; }
.wn .eyebrow { font-size: 0.78rem; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--brass); }
.wn h1 { font-family: var(--wn-display); font-weight: 600; font-size: clamp(2.9rem, 8vw, 5.4rem); line-height: 1.02; letter-spacing: -0.01em; margin: 0; text-wrap: balance; color: var(--ink); }
.wn h1 .accent { color: var(--green); font-style: italic; }
.wn .lede { font-size: clamp(1.1rem, 2.2vw, 1.4rem); line-height: 1.5; color: var(--ink-soft); max-width: 34ch; margin: 0; }
.wn .hero-meta { display: flex; flex-wrap: wrap; gap: 0.5rem 1.4rem; font-size: 0.85rem; color: var(--muted); padding-top: 0.4rem; border-top: 1px solid var(--line); width: 100%; max-width: 520px; }
.wn .hero-meta b { color: var(--ink); font-weight: 600; }

/* Intro */
.wn .intro { padding: clamp(2.5rem, 6vw, 4.5rem) 0; border-bottom: 1px solid var(--line); }
.wn .intro p { font-family: var(--wn-display); font-size: clamp(1.35rem, 3vw, 1.9rem); line-height: 1.5; color: var(--ink); max-width: 24ch; margin: 0; text-wrap: balance; }
.wn .intro .sub { font-family: var(--wn-sans); font-size: 1.05rem; line-height: 1.65; color: var(--ink-soft); max-width: 62ch; margin: 1.4rem 0 0; }

/* Features */
.wn .features { padding: clamp(1rem, 3vw, 2rem) 0 1rem; }
.wn .feature { display: grid; grid-template-columns: 1fr; gap: 1rem; padding: clamp(2rem, 5vw, 3.4rem) 0; border-bottom: 1px solid var(--line); }
@media (min-width: 760px) { .wn .feature { grid-template-columns: 0.85fr 1.15fr; gap: 3rem; } }
.wn .feature-head .kicker { font-size: 0.75rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; color: var(--brass); display: block; margin-bottom: 0.7rem; }
.wn .feature-head h2 { font-family: var(--wn-display); font-weight: 600; font-size: clamp(1.7rem, 3.6vw, 2.4rem); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 0.8rem; color: var(--ink); text-wrap: balance; }
.wn .feature-head .say { color: var(--ink-soft); font-size: 1.02rem; margin: 0; max-width: 40ch; }
.wn ul.points { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.wn ul.points li { position: relative; padding-left: 1.7rem; color: var(--ink-soft); line-height: 1.55; }
.wn ul.points li::before { content: ""; position: absolute; left: 0.15rem; top: 0.62em; width: 8px; height: 8px; border-radius: 2px; background: var(--brass); transform: rotate(45deg); }
.wn ul.points li b { color: var(--ink); font-weight: 600; }

/* Roles */
.wn .roles { padding: clamp(3rem, 7vw, 5rem) 0; background: var(--surface-2); border-bottom: 1px solid var(--line); }
.wn .section-lead { max-width: 60ch; margin: 0 0 clamp(1.8rem, 4vw, 2.8rem); }
.wn .section-lead .kicker { font-size: 0.75rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; color: var(--brass); display: block; margin-bottom: 0.7rem; }
.wn .section-lead h2 { font-family: var(--wn-display); font-weight: 600; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.08; letter-spacing: -0.01em; margin: 0 0 0.6rem; color: var(--ink); text-wrap: balance; }
.wn .section-lead p { color: var(--ink-soft); margin: 0; font-size: 1.05rem; }
.wn .role-grid { display: grid; grid-template-columns: 1fr; gap: 1.2rem; }
@media (min-width: 720px) { .wn .role-grid { grid-template-columns: repeat(3, 1fr); align-items: start; } }
.wn .role-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 1.6rem 1.5rem 1.7rem; display: flex; flex-direction: column; gap: 1rem; box-shadow: 0 1px 0 color-mix(in srgb, var(--ink) 4%, transparent); }
.wn .role-emblem { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 10px; background: color-mix(in srgb, var(--green) 14%, transparent); color: var(--green); }
.wn .role-card h3 { font-family: var(--wn-display); font-weight: 600; font-size: 1.35rem; margin: 0; color: var(--ink); }
.wn .role-card .who { font-size: 0.82rem; color: var(--muted); margin: -0.6rem 0 0; }
.wn .role-card ul { list-style: none; margin: 0.2rem 0 0; padding: 0; display: grid; gap: 0.75rem; }
.wn .role-card li { position: relative; padding-left: 1.4rem; font-size: 0.96rem; line-height: 1.5; color: var(--ink-soft); }
.wn .role-card li::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 6px; height: 6px; border-radius: 50%; background: var(--brass); }
.wn .role-card li b { color: var(--ink); font-weight: 600; }

/* Trust */
.wn .trust { padding: clamp(3rem, 7vw, 5rem) 0; border-bottom: 1px solid var(--line); }
.wn .trust-grid { display: grid; grid-template-columns: 1fr; gap: 1.2rem; }
@media (min-width: 720px) { .wn .trust-grid { grid-template-columns: repeat(3, 1fr); } }
.wn .trust-item { border-top: 2px solid var(--green); padding-top: 1rem; }
.wn .trust-item h4 { font-family: var(--wn-display); font-weight: 600; font-size: 1.15rem; margin: 0 0 0.4rem; color: var(--ink); }
.wn .trust-item p { margin: 0; color: var(--ink-soft); font-size: 0.98rem; }

/* Glance */
.wn .glance { padding: clamp(3rem, 7vw, 5rem) 0; }
.wn .glance-grid { display: grid; grid-template-columns: 1fr; gap: 1.6rem 2.4rem; }
@media (min-width: 620px) { .wn .glance-grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 940px) { .wn .glance-grid { grid-template-columns: repeat(3, 1fr); } }
.wn .glance-col h4 { font-size: 0.75rem; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 700; color: var(--green); margin: 0 0 0.9rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--line); }
.wn .glance-col ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
.wn .glance-col li { font-size: 0.94rem; color: var(--ink-soft); line-height: 1.45; padding-left: 1.1rem; position: relative; }
.wn .glance-col li::before { content: "\\2713"; position: absolute; left: 0; top: 0; color: var(--brass); font-size: 0.8rem; font-weight: 700; }

/* Footer */
.wn .wn-footer { background: var(--green); color: #F4F5F2; padding: clamp(2.6rem, 6vw, 4rem) 0; }
.wn .wn-footer .foot-inner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1.4rem; }
.wn .wn-footer .foot-mark { font-family: var(--wn-display); font-size: 1.5rem; font-weight: 600; display: flex; align-items: center; gap: 0.7rem; }
.wn .wn-footer .foot-chip { background: #fff; border-radius: 10px; padding: 7px 11px; display: inline-flex; align-items: center; }
.wn .wn-footer .foot-chip .brandmark-sm { display: block; height: 30px; width: auto; }
.wn .wn-footer p { margin: 0; color: color-mix(in srgb, #F4F5F2 78%, transparent); font-size: 0.9rem; max-width: 44ch; }

/* Reveal */
.wn .reveal { opacity: 0; transform: translateY(18px); transition: opacity 0.7s ease, transform 0.7s ease; }
.wn .reveal.in { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { .wn .reveal { opacity: 1; transform: none; transition: none; } }

.wn ::selection { background: color-mix(in srgb, var(--brass) 35%, transparent); }
`;

export default function WhatsNewPage() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".wn .reveal"));
    if (
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <>
      <Header currentPage="whats-new" />
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div className="wn">
        {/* Hero */}
        <header className="hero">
          <div className="wrap hero-inner">
            <Image
              className="brandmark"
              src="/raffles-hall-logo.svg"
              alt="Raffles Hall"
              width={76}
              height={54}
              priority
              unoptimized
            />
            <span className="eyebrow">Raffles Hall · The residents&rsquo; app</span>
            <h1>
              The New <span className="accent">RHApp</span>
            </h1>
            <p className="lede">
              Everything that&rsquo;s new to make hall life easier — your CCAs, their events, your bookings, all in one place.
            </p>
            <div className="hero-meta">
              <span><b>A home for hall life</b></span>
              <span>CCAs · Events · Bookings</span>
              <span>Live now</span>
            </div>
          </div>
        </header>

        {/* Intro */}
        <section className="intro">
          <div className="wrap reveal">
            <p>The RHApp has grown up.</p>
            <p className="sub">
              What started as a simple room-booking tool is now a proper home for hall life. This is a plain-language tour of everything we&rsquo;ve added — no jargon, just what you can now do.
            </p>
          </div>
        </section>

        {/* Features */}
        <div className="wrap features">
          <article className="feature reveal">
            <div className="feature-head">
              <span className="kicker">CCAs</span>
              <h2>CCAs finally have a home</h2>
              <p className="say">Every CCA now has its own space in the app — a real page it can call its own.</p>
            </div>
            <ul className="points">
              <li><b>A proper CCA page.</b> Each CCA gets a banner, a logo, and a description its heads write themselves. It looks the part.</li>
              <li><b>Heads make it their own.</b> Upload a logo and banner and edit the description right from the app — images are tidied up automatically so they always look sharp, even straight from a phone.</li>
              <li><b>&ldquo;My CCAs&rdquo; for everyone.</b> A personal dashboard of the CCAs you&rsquo;re part of. Lead one? It&rsquo;s marked with a badge and a shortcut to manage it.</li>
              <li><b>On your profile.</b> The CCAs you belong to now show up on your profile, neatly grouped, with your role in each.</li>
            </ul>
          </article>

          <article className="feature reveal">
            <div className="feature-head">
              <span className="kicker">Recruitment</span>
              <h2>Joining a CCA happens in the app</h2>
              <p className="say">The whole &ldquo;apply, interview, get in&rdquo; journey used to live in forms and DMs. Now it&rsquo;s built right in.</p>
            </div>
            <ul className="points">
              <li><b>Browse and apply.</b> Apply straight from a CCA&rsquo;s page, with a spot to tell the committee why you&rsquo;re interested. No accidental double-applications.</li>
              <li><b>Book your own interview slot.</b> Pick an interview time from the slots the CCA has opened — and reschedule or cancel it yourself.</li>
              <li><b>Track where you stand.</b> A &ldquo;My applications&rdquo; page shows every CCA you&rsquo;ve applied to and exactly where each one is.</li>
              <li><b>Heads run the whole thing.</b> Open interview slots in bulk, see the day as a clean schedule, review applications, take notes, and accept people straight into the CCA.</li>
            </ul>
          </article>

          <article className="feature reveal">
            <div className="feature-head">
              <span className="kicker">Events</span>
              <h2>Discover events, sign up, show up</h2>
              <p className="say">A brand-new events system connects CCAs, the JCRC, and residents.</p>
            </div>
            <ul className="points">
              <li><b>CCAs propose, JCRC approves.</b> Events go through a quick review so the hall calendar stays coordinated and nothing clashes.</li>
              <li><b>Rooms book themselves.</b> Approve an event using a hall facility and the room is reserved automatically — no separate step, no double-bookings.</li>
              <li><b>A beautiful timeline.</b> Scroll what&rsquo;s coming up with banners, dates and locations. Filter by upcoming, the ones you&rsquo;re going to, or past.</li>
              <li><b>One-tap sign-up.</b> Sign up or change your mind in a tap. Events fill up fairly, with no accidental double sign-ups.</li>
            </ul>
          </article>

          <article className="feature reveal">
            <div className="feature-head">
              <span className="kicker">Bookings &amp; profile</span>
              <h2>Bookings and your profile, improved</h2>
              <p className="say">The original booking experience — and your account — got some long-overdue love.</p>
            </div>
            <ul className="points">
              <li><b>See upcoming bookings.</b> Previously &ldquo;Your Bookings&rdquo; only showed past ones — now you see everything, marked <b>Incoming</b> or <b>Completed</b>.</li>
              <li><b>Find bookings faster.</b> Search by facility or event, filter by room, and choose how far back to look.</li>
              <li><b>Edit your own details.</b> Update your name, Telegram, bio, block, and matriculation number yourself — no need to ask anyone.</li>
              <li><b>Kept private.</b> Your matriculation number is hidden by default, with a tap to reveal, and a smoother sign-in guides new accounts through setup.</li>
            </ul>
          </article>
        </div>

        {/* Roles */}
        <section className="roles">
          <div className="wrap">
            <div className="section-lead reveal">
              <span className="kicker">Broken down by role</span>
              <h2>What&rsquo;s new for you</h2>
              <p>The same app does different things depending on who you are in the hall. Here&rsquo;s what each group gets.</p>
            </div>
            <div className="role-grid">
              <div className="role-card reveal">
                <div className="role-emblem" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" /></svg>
                </div>
                <div>
                  <h3>The JCRC</h3>
                  <p className="who">Hall committee</p>
                </div>
                <ul>
                  <li><b>Approve events</b> proposed by CCAs, or send them back with feedback.</li>
                  <li><b>Rooms sorted automatically</b> when an event is approved — no chasing, no clashes.</li>
                  <li><b>See any CCA&rsquo;s roster</b> — heads and members, all in one place.</li>
                  <li><b>Manage who leads each CCA,</b> including onboarding a whole new committee at once.</li>
                  <li><b>A clear record</b> of who changed what, and when.</li>
                </ul>
              </div>

              <div className="role-card reveal">
                <div className="role-emblem" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 5 5.6.5-4.2 3.7 1.3 5.6L12 19l-5.1 2.8 1.3-5.6L4 12.5 9.6 12z" /></svg>
                </div>
                <div>
                  <h3>CCA heads</h3>
                  <p className="who">The people who run the clubs</p>
                </div>
                <ul>
                  <li><b>Your own CCA dashboard,</b> with a quick switcher if you run more than one.</li>
                  <li><b>Make your CCA look great</b> — logo, banner and description, all yours to edit.</li>
                  <li><b>Run recruitment end to end</b> — slots, interviews, notes, and accept straight into the CCA.</li>
                  <li><b>Manage your roster,</b> removing members singly or in bulk.</li>
                  <li><b>Put on events</b> and, once approved, publish them with photos and details.</li>
                  <li><b>Know your turnout</b> — sign-ups over time, by block, with a downloadable list.</li>
                  <li><b>Hand over cleanly</b> to the next committee when your term ends.</li>
                </ul>
              </div>

              <div className="role-card reveal">
                <div className="role-emblem" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
                </div>
                <div>
                  <h3>Residents</h3>
                  <p className="who">Everyone in the hall</p>
                </div>
                <ul>
                  <li><b>Discover and join CCAs</b> — apply, book an interview, and track your application.</li>
                  <li><b>See the CCAs you&rsquo;re in</b> on a &ldquo;My CCAs&rdquo; dashboard and on your profile.</li>
                  <li><b>Find and attend events</b> — scroll the timeline and sign up in a tap.</li>
                  <li><b>Book and manage rooms,</b> including your upcoming bookings.</li>
                  <li><b>Own your profile</b> — edit your details, with your matric number kept private.</li>
                  <li><b>A smoother start</b> when signing in and setting up.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Trust */}
        <section className="trust">
          <div className="wrap">
            <div className="section-lead reveal">
              <span className="kicker">Behind the scenes</span>
              <h2>Quietly, it also got safer</h2>
              <p>Not everything new is something you click. A lot of work went into making the app trustworthy behind the scenes.</p>
            </div>
            <div className="trust-grid reveal">
              <div className="trust-item">
                <h4>Your bookings are yours</h4>
                <p>We closed a gap where booking details could be seen by the wrong person. Only you — and hall admins — can see your booking&rsquo;s details now.</p>
              </div>
              <div className="trust-item">
                <h4>One account per person</h4>
                <p>We cleaned up years of accidental duplicate accounts, carefully merging everyone&rsquo;s bookings, gym visits and memberships onto one — without losing a thing.</p>
              </div>
              <div className="trust-item">
                <h4>Fewer silent glitches</h4>
                <p>A whole category of quiet, hard-to-spot bugs was tracked down and fixed, with safeguards so they can&rsquo;t creep back in. The app behaves the way you&rsquo;d expect.</p>
              </div>
            </div>
          </div>
        </section>

        {/* At a glance */}
        <section className="glance">
          <div className="wrap">
            <div className="section-lead reveal">
              <span className="kicker">The full list</span>
              <h2>Everything new, at a glance</h2>
            </div>
            <div className="glance-grid reveal">
              <div className="glance-col">
                <h4>CCAs</h4>
                <ul>
                  <li>Dedicated CCA pages with banner, logo &amp; description</li>
                  <li>Head-editable branding</li>
                  <li>&ldquo;My CCAs&rdquo; resident dashboard</li>
                  <li>CCAs &amp; roles shown on your profile</li>
                  <li>Per-CCA head dashboard with quick switcher</li>
                  <li>Roster management, single or bulk</li>
                  <li>Self-service head handover</li>
                </ul>
              </div>
              <div className="glance-col">
                <h4>Joining a CCA</h4>
                <ul>
                  <li>Browse and apply in-app</li>
                  <li>Book, reschedule or cancel your interview slot</li>
                  <li>&ldquo;My applications&rdquo; status tracker</li>
                  <li>Bulk-open interview slots</li>
                  <li>Day-view interview schedule</li>
                  <li>Review applications &amp; take notes</li>
                  <li>Accept straight into the roster</li>
                </ul>
              </div>
              <div className="glance-col">
                <h4>Events</h4>
                <ul>
                  <li>CCAs propose, JCRC approves</li>
                  <li>Automatic room booking on approval</li>
                  <li>Scrolling events timeline</li>
                  <li>Upcoming / my events / past filters</li>
                  <li>One-tap sign-up with fair limits</li>
                  <li>Event pages with photo galleries</li>
                  <li>Turnout stats for heads</li>
                </ul>
              </div>
              <div className="glance-col">
                <h4>Bookings</h4>
                <ul>
                  <li>See upcoming bookings, not just past</li>
                  <li>Incoming / Completed labels</li>
                  <li>Search &amp; filter by facility or event</li>
                  <li>Right rooms for the right groups</li>
                </ul>
              </div>
              <div className="glance-col">
                <h4>Profile &amp; account</h4>
                <ul>
                  <li>Edit your own details</li>
                  <li>Roles &amp; memberships shown clearly</li>
                  <li>Hidden-by-default matric number</li>
                  <li>Smoother sign-in &amp; setup</li>
                  <li>Clear messaging for ineligible accounts</li>
                </ul>
              </div>
              <div className="glance-col">
                <h4>Reliability</h4>
                <ul>
                  <li>Booking details kept private</li>
                  <li>Duplicate accounts merged, no data lost</li>
                  <li>A wide sweep of quiet bugs fixed</li>
                  <li>Safeguards to keep them out</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="wn-footer">
          <div className="wrap foot-inner">
            <div className="foot-mark">
              <span className="foot-chip">
                <Image
                  className="brandmark-sm"
                  src="/raffles-hall-logo.svg"
                  alt="Raffles Hall"
                  width={42}
                  height={30}
                  unoptimized
                />
              </span>
              <span>The New RHApp</span>
            </div>
            <p>Built for Raffles Hall — a home for hall life, in one place.</p>
          </div>
        </footer>
      </div>
    </>
  );
}
