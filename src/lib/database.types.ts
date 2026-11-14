// The CLIMBR database, as TypeScript. Hand-kept in step with
// supabase/migrations; regenerate with `supabase gen types typescript` once the
// project exists and replace this file.
export type ClimbStatus = 'sent' | 'unfinished' | 'unclear'
export type Visibility = 'private' | 'public'
export type ReportReason = 'not_climbing' | 'inappropriate' | 'other'

export interface ProfileRow { id: string; username: string; theme: 'lime' | 'sunset' | 'dusk'; created_at: string }
export interface ClimbRow {
  id: string
  user_id: string
  title: string
  video_path: string
  thumbnail_path: string | null
  duration: number
  route_color: string
  hold_count: number
  status: ClimbStatus
  coach_score: number
  sub_scores: { key: string; label: string; value: number }[]
  analysis: unknown // the Session, minus this device's object URLs
  highlight: { title: string; body: string; time: number | null } | null
  visibility: Visibility
  is_approved: boolean
  is_example: boolean
  hidden_at: string | null
  reviewed_at: string | null
  created_at: string
}
export interface PropRow { user_id: string; climb_id: string; created_at: string }
export interface SaveRow { user_id: string; climb_id: string; created_at: string }
export interface ReportRow { id: string; reporter_id: string; climb_id: string; reason: ReportReason; created_at: string }

/** What feed(), saved_feed() and my_climbs() return: a climb as shown on a card. */
export interface ClimbCard extends Pick<ClimbRow, 'id' | 'title' | 'route_color' | 'hold_count' | 'duration' | 'status' | 'coach_score' | 'sub_scores' | 'highlight' | 'visibility' | 'is_approved' | 'is_example' | 'created_at' | 'video_path' | 'thumbnail_path'> {
  username: string
  mine: boolean
  propped: boolean
  saved: boolean
  props: string | null // exact for your own climbs, a soft range for anyone else's
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfileRow; Insert: Pick<ProfileRow, 'id' | 'username'> & Partial<ProfileRow>; Update: Partial<Pick<ProfileRow, 'username' | 'theme'>> }
      climbs: { Row: ClimbRow; Insert: Omit<ClimbRow, 'is_approved' | 'is_example' | 'hidden_at' | 'reviewed_at' | 'created_at'> & Partial<ClimbRow>; Update: Partial<Pick<ClimbRow, 'visibility' | 'title'>> }
      props: { Row: PropRow; Insert: Pick<PropRow, 'user_id' | 'climb_id'>; Update: never }
      saves: { Row: SaveRow; Insert: Pick<SaveRow, 'user_id' | 'climb_id'>; Update: never }
      reports: { Row: ReportRow; Insert: never; Update: never }
    }
    Functions: {
      feed: { Args: { p_cursor?: string | null; p_limit?: number; p_color?: string | null }; Returns: ClimbCard[] }
      saved_feed: { Args: { p_cursor?: string | null; p_limit?: number }; Returns: ClimbCard[] }
      my_climbs: { Args: Record<string, never>; Returns: ClimbCard[] }
      get_climb: { Args: { p_id: string }; Returns: (ClimbCard & { analysis: unknown }) | null }
      report_climb: { Args: { p_climb: string; p_reason: ReportReason }; Returns: void }
    }
  }
}
