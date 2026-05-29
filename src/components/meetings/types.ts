export type InvitationStatus = "pending" | "accepted" | "declined" | "expired";

export interface InvitationRow {
  id: string;
  status: InvitationStatus;
  invited_at: string;
  responded_at: string | null;
  invitee: { id: string; display_name: string | null } | null;
}

export interface MeetingRow {
  id: string;
  starts_at: string;
  duration_minutes: number;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  description: string;
  created_at: string;
  creator: { id: string; display_name: string | null } | null;
  invitations: InvitationRow[];
}

export interface PendingInvitation {
  invitation_id: string;
  meeting: MeetingRow;
}

export interface ClashingMeetingSummary {
  id: string;
  starts_at: string;
  duration_minutes: number;
}
