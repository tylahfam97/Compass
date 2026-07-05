export interface Account {
  id: number;
  name: string;
  account_type: string;
  institution: string;
  created_at: string;
}

export interface Transaction {
  id: number;
  account_id: number;
  date: string;
  amount_cents: number;
  description: string;
  category_id: number | null;
  notes: string | null;
  import_hash: string;
  created_at: string;
  // Joined from categories table
  category_name?: string;
  category_color?: string;
}

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  color: string;
  icon: string;
  is_system: boolean;
}

export interface Budget {
  id: number;
  category_id: number;
  amount_cents: number;
  period: "monthly" | "weekly";
  start_date: string;
}

export interface CategorizationRule {
  id: number;
  pattern: string;
  match_type: "contains" | "starts_with" | "regex";
  category_id: number;
  priority: number;
}
