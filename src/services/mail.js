import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

const transporter = hasSmtp
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

export async function sendRegistrationApproved({ email, firstName, tournamentName }) {
  const subject = 'Registration Approved — You\'re In!';
  const html = `
    <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto;">
      <h1 style="color: #C9A227;">Congratulations, ${firstName}!</h1>
      <p>Your registration has been <strong>approved</strong>. You are now eligible to compete${tournamentName ? ` in <em>${tournamentName}</em>` : ''}.</p>
      <p>We will email you when your first match is scheduled. Good luck!</p>
      <p style="color: #666; font-size: 14px;">— Win a Car Tournament Team</p>
    </div>
  `;
  return sendMail({ to: email, subject, html });
}

export async function sendRegistrationRejected({ email, firstName, reason }) {
  const subject = 'Registration Update';
  const html = `
    <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto;">
      <h1 style="color: #1A1A1A;">Hello ${firstName},</h1>
      <p>Unfortunately we could not approve your registration at this time.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      <p>If you believe this was a mistake, please contact our support team with your payment screenshot.</p>
      <p style="color: #666; font-size: 14px;">— Win a Car Tournament Team</p>
    </div>
  `;
  return sendMail({ to: email, subject, html });
}

async function sendMail({ to, subject, html }) {
  const from = process.env.SMTP_FROM || 'noreply@giveaway.local';

  if (!transporter) {
    console.log('\n--- EMAIL (dev mode, SMTP not configured) ---');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(html.replace(/<[^>]+>/g, ' ').slice(0, 300) + '...');
    console.log('---\n');
    return { messageId: 'dev-mode' };
  }

  return transporter.sendMail({ from, to, subject, html });
}
