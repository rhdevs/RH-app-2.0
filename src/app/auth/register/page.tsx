import Link from "next/link";

export default function AuthPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
      <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
        <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
          Register an account
        </h1>
        <div className="flex flex-col items-center gap-2">
          <form className="flex flex-col gap-4">
            <label htmlFor="email" className="text-xl">
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              className="rounded px-4 py-2"
            />
            <label htmlFor="password" className="text-xl">
              Password
            </label>
            <input
              type="password"
              id="password"
              name="password"
              className="rounded px-4 py-2"
            />
            <button
              type="submit"
              className="rounded bg-white/10 px-4 py-2 hover:bg-white/20"
            >
              Login
            </button>
          </form>
        </div>
        <Link
          href="/register"
          className="mt-8 rounded bg-white/10 px-4 py-2 hover:bg-white/20"
        >
          Already have an account? Login
        </Link>
      </div>
    </main>
  );
}
