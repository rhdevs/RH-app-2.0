export interface BookingData {
  id: string;
  start: Date;
  end: Date;
  title?: string | null;
  user: string;
  eventName?: string | null;
  userTeleHandle: string;
}