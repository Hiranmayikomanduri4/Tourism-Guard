import { create } from "zustand";

type User = { id: string; name: string; email: string; role: "tourist" | "authority" };
type State = {
  language: string;
  setLanguage: (language: string) => void;
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
};

export const useAuth = create<State>((set) => ({
  language: localStorage.getItem("tg_language") || "en",
  setLanguage: (language) => { localStorage.setItem("tg_language", language); set({ language }); },
  token: localStorage.getItem("tg_token"),
  user: JSON.parse(localStorage.getItem("tg_user") || "null"),
  setAuth: (token, user) => { localStorage.setItem("tg_token", token); localStorage.setItem("tg_user", JSON.stringify(user)); set({ token, user }); },
  logout: () => { localStorage.removeItem("tg_token"); localStorage.removeItem("tg_user"); set({ token: null, user: null }); }
}));
