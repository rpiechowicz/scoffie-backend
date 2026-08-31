// Dekorator mieszka teraz w `src/auth/` (tam, gdzie `JwtAuthGuard` ustawia
// `request.user`). Re-eksport, żeby nie przepisywać importów w integracjach.
export { CurrentUserId } from '../auth/current-user-id.decorator';
