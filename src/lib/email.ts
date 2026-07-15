import { Resend } from "resend";

import { env } from "~/env";

const resend = new Resend(env.RESEND_API_KEY);

/**
 * Sends a single-use password-reset link to the account's own email address
 * (#1/#2). The link carries an opaque token; nothing about the destination is
 * client-controlled, so a reset can't be redirected to an attacker's inbox.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  const { data, error } = await resend.emails.send({
    from: "RHApp <noreply@rhapp.lol>",
    to: [email],
    subject: "Reset your RHApp password",
    html: `
  <div style="font-family: sans-serif; line-height: 1.5;">
    <p>We received a request to reset your RHApp password.</p>
    <p>
      <a href="${resetUrl}"
         style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
        Reset your password
      </a>
    </p>
    <p>Or paste this link into your browser:</p>
    <p style="word-break:break-all;color:#059669;">${resetUrl}</p>
    <p>This link expires in <strong>15 minutes</strong> and can be used once.</p>
    <p>If you didn't request a password reset, you can safely ignore this email.</p>
  </div>
`,
  });

  if (error) {
    console.error("Failed to send password reset email:", error);
    throw new Error(error.message);
  }

  return data;
}
