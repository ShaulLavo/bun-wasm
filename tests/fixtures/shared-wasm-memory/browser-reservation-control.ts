import { runReservationGuests } from './reservation-guests.ts';

// reservation-capacity.ts stays with the native host. The Browser host admits the same Rolldown
// descriptor as the root guest of tests/fixtures/shared-group-address-space, where its group is
// the only one charged to the page's backing budget.
await runReservationGuests(['reservation', 'reservation-binding']);
