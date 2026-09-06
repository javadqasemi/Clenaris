import type { Metadata } from 'next';

import { ForgotPasswordForm } from '@/features/auth/password-forms';

export const metadata: Metadata = {
  title: 'Passwort zurücksetzen',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
