import type { AttendanceStatus } from '../../domain/events';

export interface AttendanceRequestCopy {
  title: string;
  message: string;
}

/** A recorded intention can lose eligibility without becoming a confirmed registration. */
export function attendanceRequestCopy(status: AttendanceStatus): AttendanceRequestCopy | null {
  switch (status) {
    case 'pending': return {
      title: 'Request sent',
      message: 'Your request is saved. The organizer must confirm it; you do not have a confirmed place yet.',
    };
    case 'waitlisted': return {
      title: 'You’re on the waiting list',
      message: 'The organizer will confirm your place if one becomes available. You do not have a confirmed place yet.',
    };
    case 'full': return {
      title: 'No place is confirmed',
      message: 'Your request is still recorded, but all places are reserved and this request is not on the waiting list. You do not have a confirmed place.',
    };
    case 'invitation_required': return {
      title: 'Your request needs an invitation',
      message: 'Your request is still recorded, but this wallet is not on the current invitation list. You do not have a confirmed place.',
    };
    case 'registration_closed': return {
      title: 'Your request missed the deadline',
      message: 'Your request is still recorded, but it falls outside the current registration deadline. You do not have a confirmed place.',
    };
    default: return null;
  }
}
