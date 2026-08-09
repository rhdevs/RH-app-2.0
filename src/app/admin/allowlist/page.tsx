"use client";

import AuthAllowlistPanel from "../_components/allowlist/AuthAllowlistPanel";

export default function AdminAllowlistPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          Authentication allowlist
        </h1>
        <p className="text-sm text-gray-500">
          Every resident&rsquo;s identity is derived from their
          @u.nus.edu address. This is the ONE exception: a row here pins a
          non-NUS address — hall office staff on @nus.edu.sg — to an
          admin-issued key in the <code className="font-mono">EXT:</code>{" "}
          namespace, so that address can sign in and hold roles at all. There
          is no other way onto this list; it cannot be self-served, and it is
          not a role grant by itself, only the identity a role can later be
          granted to.
        </p>
      </div>
      <AuthAllowlistPanel />
    </div>
  );
}
