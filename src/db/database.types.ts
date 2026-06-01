export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      friend_connections: {
        Row: {
          addressee_id: string
          id: string
          requested_at: string
          requester_id: string
          status: Database["public"]["Enums"]["friend_connection_status"]
        }
        Insert: {
          addressee_id: string
          id?: string
          requested_at?: string
          requester_id: string
          status?: Database["public"]["Enums"]["friend_connection_status"]
        }
        Update: {
          addressee_id?: string
          id?: string
          requested_at?: string
          requester_id?: string
          status?: Database["public"]["Enums"]["friend_connection_status"]
        }
        Relationships: [
          {
            foreignKeyName: "friend_connections_addressee_id_fkey"
            columns: ["addressee_id"]
            isOneToOne: false
            referencedRelation: "parents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friend_connections_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "parents"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_invitations: {
        Row: {
          id: string
          invited_at: string
          invitee_id: string
          meeting_id: string
          responded_at: string | null
          status: Database["public"]["Enums"]["meeting_invitation_status"]
        }
        Insert: {
          id?: string
          invited_at?: string
          invitee_id: string
          meeting_id: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["meeting_invitation_status"]
        }
        Update: {
          id?: string
          invited_at?: string
          invitee_id?: string
          meeting_id?: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["meeting_invitation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "meeting_invitations_invitee_id_fkey"
            columns: ["invitee_id"]
            isOneToOne: false
            referencedRelation: "parents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_invitations_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          city: string
          country: string
          created_at: string
          creator_id: string
          description: string
          duration_minutes: number
          id: string
          postal_code: string
          starts_at: string
          street: string
        }
        Insert: {
          city: string
          country: string
          created_at?: string
          creator_id: string
          description: string
          duration_minutes?: number
          id?: string
          postal_code: string
          starts_at: string
          street: string
        }
        Update: {
          city?: string
          country?: string
          created_at?: string
          creator_id?: string
          description?: string
          duration_minutes?: number
          id?: string
          postal_code?: string
          starts_at?: string
          street?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "parents"
            referencedColumns: ["id"]
          },
        ]
      }
      parents: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_meeting_with_invitations: {
        Args: {
          p_city: string
          p_country: string
          p_description: string
          p_duration_minutes: number
          p_invitee_ids: string[]
          p_postal_code: string
          p_starts_at: string
          p_street: string
        }
        Returns: string
      }
      expire_stale_invitations: { Args: never; Returns: number }
      find_parent_by_handle: {
        Args: { handle: string }
        Returns: {
          display_name: string
          id: string
        }[]
      }
      is_connected: {
        Args: { owner: string; viewer: string }
        Returns: boolean
      }
      list_my_friends: {
        Args: never
        Returns: {
          display_name: string
          id: string
        }[]
      }
      user_is_meeting_creator: {
        Args: { p_meeting_id: string; p_user_id: string }
        Returns: boolean
      }
      user_is_meeting_invitee: {
        Args: { p_meeting_id: string; p_user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      friend_connection_status: "pending" | "accepted" | "declined"
      meeting_invitation_status: "pending" | "accepted" | "declined" | "expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      friend_connection_status: ["pending", "accepted", "declined"],
      meeting_invitation_status: ["pending", "accepted", "declined", "expired"],
    },
  },
} as const

