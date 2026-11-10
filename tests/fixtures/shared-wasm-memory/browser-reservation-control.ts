import { runReservationGuests } from './reservation-guests.ts';

// reservation-capacity.ts stays with the native host: its 14000-page row is that host's measured
// room beside a member, and a Browser member's own footprint has not been measured.
await runReservationGuests(['reservation', 'reservation-binding']);
