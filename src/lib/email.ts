import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendVerificationCodeEmail(email: string, code: string) {
  const { data, error } = await resend.emails.send({
    from: "RHApp <noreply@rhapp.lol>",
    to: [email],
    subject: "Your Password Reset Code",
    html: `
  <div style="font-family: sans-serif; line-height: 1.5;">
    <p>Your verification code is:</p>
    <h2 style="color: #1a73e8; margin: 0;">${code}</h2>
    <p>This code will expire in <strong>15 minutes</strong>.</p>
    <p>If you didn't request a password reset, you can safely ignore this email.</p>
  </div>
`,
  });

  if (error) {
    console.error("Failed to send verification code email:", error);
    throw new Error(error.message);
  }

  return data;
}
