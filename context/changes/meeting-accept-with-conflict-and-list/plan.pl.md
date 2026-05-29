# Plan implementacji: Akceptacja spotkania z ostrzeżeniem o konflikcie i lista (S-03)

> Wersja polska planu. Oryginał (kanoniczny dla narzędzi): `plan.md`.

## Wprowadzenie

S-03 domyka pętlę co-care: zaproszony rodzic może zaakceptować lub odrzucić oczekujące zaproszenie na spotkanie, widzi w chwili akceptacji ostrzeżenie o konflikcie, jeśli spotkanie nakłada się na coś już obecnego w jego harmonogramie (FR-009), a strona `/meetings` zmienia układ na trzy sekcje — Oczekujące zaproszenia → Nadchodzące → Minione (FR-010) — zasilane jednym połączonym widokiem spotkań, które rodzic utworzył LUB już zaakceptował. Warstwa danych jest w większości gotowa po S-02; ten slice dodaje jedną kolumnę (`responded_at`), jedną politykę RLS UPDATE, jeden kolumnowy GRANT, jeden nowy endpoint API (analogiczny do `/api/friends/respond`), serwerową mapę wykrywania konfliktów na stronie oraz komponent listy świadomy perspektywy widza.

## Analiza obecnego stanu

- **Warstwa danych (S-02, zarchiwizowane).** `public.meetings` + `public.meeting_invitations` są w `supabase/migrations/20260528105428_meetings_foundation.sql` z enumem `meeting_invitation_status` zawierającym od pierwszego dnia cztery wartości (`pending / accepted / declined / expired`). Pomocnicze funkcje SELECT cross-table (`public.user_is_meeting_invitee`, `public.user_is_meeting_creator`) omijają rekurencję RLS. **Nie istnieje** dziś polityka UPDATE dla `meeting_invitations`. Migracja wykonuje `revoke update, delete on public.meeting_invitations from authenticated` — połowa wzorca column-grant w postaci REVOKE jest **już na miejscu**, więc S-03 wymaga tylko kolumnowego GRANT.
- **Powierzchnia API (S-02, zarchiwizowane).** Istnieją `POST /api/meetings` i `DELETE /api/meetings/[id]`. Brak endpointu respond. Endpoint friend-respond w `src/pages/api/friends/respond.ts` jest strukturalnym bliźniakiem do skopiowania.
- **Strona (S-02, zarchiwizowane).** `/meetings.astro` SSR ładuje tylko spotkania, które użytkownik **utworzył** (`eq("creator_id", user.id)`). Nie ładuje oczekujących zaproszeń otrzymanych przez użytkownika ani zaakceptowanych zaproszeń. Strona renderuje formularz tworzenia i jedną sekcję „My created meetings”. Komponent `MyMeetingsList.tsx` zakłada renderowanie z perspektywy twórcy (badge'y statusu per zaproszony + przycisk Delete).
- **Wzorzec lustrzany jest na miejscu (S-01, zarchiwizowane).** `IncomingRequestsList.tsx` + `respond.ts` razem demonstrują UX akceptuj/odrzuć w tym repozytorium: POST `{ id, action }` → serwer `update({ status: nextStatus }).eq("id", id).select().maybeSingle()` → bramka RLS USING → 404 jeśli odfiltrowane → `window.location.reload()`. Endpoint respond w S-03 powtarza dokładnie ten kształt, z dopisaniem `responded_at`.
- **Precedens column-grant (S-01, zarchiwizowane).** `friend_connections` wprowadził częściowy GRANT w `supabase/migrations/20260527103435_friend_connections_foundation.sql`: `revoke update from authenticated; grant update (status) on … to authenticated;`. S-03 podąża tym samym kształtem dla `meeting_invitations(status, responded_at)`.
- **Regeneracja typów DB.** `src/db/database.types.ts` musi zostać ponownie wygenerowane po migracji. Obecne `meeting_invitations.Row` nie zawiera `responded_at`.
- **Bez potrzeby SECURITY DEFINER RPC.** W przeciwieństwie do `create_meeting_with_invitations` (mutacja cross-table), endpoint respond modyfikuje jeden wiersz — supabase-js + polityka RLS UPDATE wystarcza. Transakcja wieloinstrukcyjna niepotrzebna.

## Docelowy stan

- Rodzic przechodzi na `/meetings` i od razu widzi trzy sekcje (powyżej dotychczasowego formularza tworzenia): **Oczekujące zaproszenia** (z inline ostrzeżeniem o konflikcie per wiersz + przyciski Akceptuj/Odrzuć), **Nadchodzące spotkania** (połączony widok twórca + zaakceptowany zaproszony, tylko przyszłe, rosnąco po dacie), **Minione spotkania** (to samo źródło, tylko przeszłe, malejąco).
- Kliknięcie Akceptuj na oczekującym zaproszeniu przestawia wiersz na `accepted` i zapisuje `responded_at = now()` atomowo, a strona przeładowuje się, odzwierciedlając nowy stan — w tym przeliczoną mapę konfliktów dla pozostałych wierszy oczekujących.
- Kliknięcie Odrzuć przestawia wiersz na `declined` i zapisuje `responded_at`, po czym strona się przeładowuje.
- Oczekujące zaproszenie, którego spotkanie nakłada się na potwierdzony harmonogram rodzica (własne spotkania ∪ zaakceptowane zaproszenia), renderuje inline ostrzeżenie nad przyciskami Akceptuj/Odrzuć, wymieniając kolidujące spotkania po dacie+godzinie. Akceptuj pozostaje aktywny — ostrzeżenie ma charakter informacyjny; drugie kliknięcie JEST zgodą.
- Rodzic nie może zmienić odpowiedzi po jej wysłaniu — polityka RLS UPDATE gateuje przez `using (auth.uid() = invitee_id and status = 'pending')` i `with check (status in ('accepted','declined'))`. Próba zwraca 404 z API.
- Rodzic nie może akceptować/odrzucać cudzego zaproszenia — RLS USING filtruje wiersz; API zwraca 404.
- Szablon wiersza działający w obu perspektywach renderuje poprawnie: spotkania utworzone przez widza pokazują badge'y statusu per zaproszony + Delete; spotkania, na które widz został zaproszony (teraz zaakceptowane), pokazują „Created by `<nazwa>`” + własny zaakceptowany status widza, bez Delete.
- AGENTS.md `§Current state` odzwierciedla nowy kształt: polityka UPDATE + kolumnowy GRANT na `(status, responded_at)`, kolumna audytu `responded_at`, kompozycja strony w trzy sekcje.
- `supabase/tests/meetings-rls.md` zawiera nowe bloki dowodzące, że polityka UPDATE pozwala zaproszonemu akceptować/odrzucać oczekujące zaproszenie, blokuje nie-zaproszonego, blokuje wiersz już rozstrzygnięty, blokuje UPDATE pól innych niż `status`/`responded_at` oraz potwierdza, że twórca nie może wykonać UPDATE.

### Kluczowe odkrycia:

- `revoke update on public.meeting_invitations from authenticated` jest **już na miejscu** po S-02 ([meetings_foundation.sql:142](supabase/migrations/20260528105428_meetings_foundation.sql#L142)) — S-03 tylko dodaje kolumnowy GRANT i politykę UPDATE.
- Indeksy częściowe dla wyszukiwań `pending` i `accepted` po `invitee_id` istnieją ([meetings_foundation.sql:43-46](supabase/migrations/20260528105428_meetings_foundation.sql#L43-L46)) — obie połówki zapytania SSR (oczekujące zaproszenia do renderu, zaakceptowane zaproszenia jako podstawa harmonogramu) są zaindeksowane.
- Bieżąca polityka SELECT dla `meetings` ([meetings_foundation.sql:99-104](supabase/migrations/20260528105428_meetings_foundation.sql#L99-L104)) już pozwala zaproszonemu widzieć spotkania, na które został zaproszony. Pojedyncze `from("meetings").select(...)` zwraca więc spotkania, które utworzyłem + spotkania, do których mam zaproszenie oczekujące LUB zaakceptowane. Filtrowanie po stronie JS układa je w trzy sekcje.
- `IncomingRequestsList.tsx` ([IncomingRequestsList.tsx:29-49](src/components/friends/IncomingRequestsList.tsx#L29-L49)) jest dosłownym strukturalnym bliźniakiem: wzorzec POST → reload, ikony lucide `Check`/`X`, stan in-flight per wiersz, styl `Button`.
- `MyMeetingsList.tsx` już obsługuje paletę badge'y statusu per zaproszony ([MyMeetingsList.tsx:39-44](src/components/meetings/MyMeetingsList.tsx#L39-L44)) — tę samą paletę użyjemy ponownie dla własnego statusu widza w perspektywie zaproszonego.
- Konwersja `<input type="datetime-local">` ↔ ISO została domknięta w S-02; S-03 nie wprowadza wejścia datetime — `responded_at` ustawia serwer przez `new Date().toISOString()`.

## Czego nie robimy

- Wygaszania (cron) `pending` zaproszeń po 24h — to S-04 (enum już zawiera `expired`; ten slice go nie zapisuje).
- Edytowania spotkania po utworzeniu — wciąż brak polityki UPDATE na `meetings` (bez zmian względem S-02).
- Zmiany listy zaproszonych po utworzeniu — wciąż brak endpointu add/remove invitee.
- Pozwalania rodzicowi na zmianę odpowiedzi (accept↔decline) — polityka one-shot; literalnie z PRD.
- Serwerowego blokowania podwójnej rezerwacji — ostrzeżenie ma charakter informacyjny; serwer wciąż pozwala akceptować kolidujące zaproszenie (PRD: „before they confirm” — potwierdzenie jest w rękach rodzica).
- Proaktywnego widoku dostępności („którzy znajomi są wolni w tym czasie”) — jawnie wyłączone w PRD §Non-Goals; trafia do przyszłej „v2” reguły konfliktów.
- Wizualnego widoku kalendarza — PRD §Non-Goals; lista pozostaje listą posortowaną po dacie.
- Powierzchni UI sterowanej `responded_at` (np. „odrzuciłeś 3 godziny temu”) — kolumna jest zapisywana, ale jeszcze nie wyświetlana.
- Licznika na dashboardzie / badge'a w topbarze dla oczekujących zaproszeń — poza zakresem; link na `/dashboard` do `/meetings` już istnieje.
- Paginacji ani wirtualizacji list nadchodzących/minionych — poza zakresem przy `target_scale.users: medium` z PRD i drugorzędnym kryterium sukcesu „3 znajomych”.
- Komponentów shadcn dialog / toast — utrzymujemy slice neutralny budżetowo dla komponentów.
- SECURITY DEFINER RPC dla mutacji respond — aktualizacja jednego wiersza; wystarczy supabase-js + RLS.

## Podejście implementacyjne

**Lustrzane odbicie wzorca friend-respond, od początku do końca.** Endpoint API, schemat żądania, kształt bramki RLS, 404 przy odfiltrowaniu przez RLS, UX accept/decline po stronie klienta i przeładowanie po odpowiedzi — wszystko już istnieje w repo dla `friend_connections`. Endpoint S-03 różni się tylko tym, że: tabelą jest `meeting_invitations`, w tej samej UPDATE zapisuje się dodatkowe pole `responded_at`, a payload odpowiedzi to 200 z nowym statusem. Defensywne `eq("status", "pending")` w wywołaniu supabase-js powtarza warunek RLS USING — pas i szelki.

**Wykrywanie konfliktu działa po stronie serwera w TypeScript, nie w SQL.** Strona Astro i tak musi pobrać pełny harmonogram rodzica (od strony twórcy + zaakceptowanego zaproszonego), żeby wyrenderować listy Nadchodzące/Minione. Ten sam zestaw danych zasila `Map<invitation_id, ClashingMeeting[]>` dla każdego oczekującego zaproszenia i jest przekazywany jako prop do `PendingInvitationsList`. Bez nowego RPC. Predykat nakładania to klasyczne `aStart < bEnd && aEnd > bStart`. Decyzja utrzymuje logikę konfliktów audytowalną jako zwykły JavaScript (jedna funkcja we frontmatterze strony), unika kosztu funkcji SQL SECURITY DEFINER dla czegoś, co w istocie jest sprawą warstwy prezentacji, i uruchamia się raz na render strony zamiast per kliknięcie Akceptuj.

**Kompozycja strony używa pojedynczego pobrania spotkań po SSR.** Ponieważ istniejąca polityka RLS `meetings_select` pozwala widzowi widzieć spotkania, w których jest twórcą LUB zaproszonym, gołe `supabase.from("meetings").select(...)` zwraca sumę — bez filtru `or()`. Następnie po stronie JS dzielimy na:

- Oczekujące zaproszenia = zaproszenia, w których `invitations[i].invitee_id == user.id && invitations[i].status == 'pending'` (potrzebujemy ciała spotkania do wyświetlenia + matematyki konfliktów).
- Mój harmonogram (jako baza do konfliktów) = spotkania, w których jestem twórcą LUB mam zaproszenie `accepted`.
- Nadchodzące = mój harmonogram, `starts_at + duration_minutes >= now()`, rosnąco.
- Minione = mój harmonogram, `starts_at + duration_minutes < now()`, malejąco.

**Komponent listy spotkań staje się świadomy perspektywy.** Dzisiejszy `MyMeetingsList.tsx` (tylko twórca) staje się bardziej ogólnym `MeetingsList.tsx` przyjmującym jawnie `viewerId` i renderującym każdy wiersz na podstawie `meeting.creator_id === viewerId`. Gałąź wiersza twórcy zachowuje listę statusów per zaproszony + przycisk Delete. Gałąź wiersza zaproszonego pokazuje „Created by `<creator_name>`” + własny badge zaakceptowanego statusu widza, bez Delete. Zmiana nazwy komponentu jest niewielka i sygnalizuje szerszą semantykę.

## Krytyczne szczegóły implementacji

- **Kształt polityki RLS UPDATE powtarza `friend_connections`.** Klauzula USING musi ograniczać do `status = 'pending'` (żeby wiersze już rozstrzygnięte zostały odfiltrowane, a API zwracało 404). Klauzula WITH CHECK musi ograniczać status wynikowy do `('accepted', 'declined')` (żeby źle zachowujący się klient nie ustawił `status = 'expired'` ani z powrotem `status = 'pending'`). Obie połówki są nośne; pominięcie którejkolwiek otwiera drogę do obejścia reguły one-shot.
- **Kolumnowy GRANT wymagany jest zarówno dla `status`, JAK i `responded_at`** — wymienienie tylko `status` zablokowałoby dwupolowe UPDATE w API błędem permission, nawet jeśli RLS WITH CHECK by przeszło. Sprawdzić po migracji przez `\dp meeting_invitations`: w kolumnie Column privileges powinien pojawić się `responded_at: authenticated=w/postgres` obok `status: authenticated=w/postgres`. (Por. lekcja z friend_connections w [AGENTS.md §Key conventions](AGENTS.md).)
- **Endpoint respond ustawia `responded_at` po stronie serwera**, nie z payloadu klienta. Klient nigdy nie wysyła znacznika czasu; endpoint stempluje `new Date().toISOString()` w tej samej UPDATE, w której flipuje `status`. Zapobiega to zanieczyszczeniu kolumny audytu dryfem zegara klienta.
- **Matematyka konfliktów uwzględnia `duration_minutes`, nie tylko `starts_at`** (zgodnie z decyzją z rundy 2 o granicy nadchodzące/minione). Wyprowadzenie „ends_at” jako `new Date(starts_at).getTime() + duration_minutes * 60_000` musi być używane konsekwentnie w sprawdzeniu nakładania konfliktów ORAZ w podziale nadchodzące/minione. Drugie miejsce obliczeń to ryzyko dryfu — wyekstrahować raz `meetingEndsAt(m)` i używać wielokrotnie.

## Faza 1: Warstwa danych

### Wprowadzenie

Jedna migracja dodająca kolumnę `responded_at`, politykę UPDATE i kolumnowy GRANT. Regeneracja typów. Rozszerzenie dokumentu testów RLS o pięć bloków pokrywających nową powierzchnię.

### Wymagane zmiany:

#### 1. Migracja: `responded_at` + polityka UPDATE + kolumnowy GRANT

**Plik**: `supabase/migrations/20260529120000_meeting_invitations_respond.sql` (nowy)

**Cel**: Dodaje kolumnę audytu, którą stempluje API, dodaje politykę RLS UPDATE pinującą, które wiersze mogą się zmienić i do jakich stanów, oraz dodaje kolumnowy GRANT pinujący zapisywalną powierzchnię do `(status, responded_at)`. Połówka REVOKE jest już na miejscu z migracji S-02 — nie emitować jej ponownie.

**Kontrakt**:

- `alter table public.meeting_invitations add column responded_at timestamptz` (nullable; null dopóki pending, stempel przy pierwszej odpowiedzi).
- `create policy meeting_invitations_update on public.meeting_invitations for update to authenticated using (auth.uid() = invitee_id and status = 'pending') with check (auth.uid() = invitee_id and status in ('accepted', 'declined'))`. Klauzula USING filtruje wiersz dla: (a) wywołujących nie-zaproszonych, (b) wierszy już rozstrzygniętych. Klauzula WITH CHECK odrzuca zapisy, które ustawiłyby `status` na `pending` lub `expired`. Status `expired` jest zarezerwowany dla pisarza cron z S-04 (inna rola, omijająca RLS).
- `grant update (status, responded_at) on public.meeting_invitations to authenticated;` — pinuje powierzchnię kolumn. Bez osobnej instrukcji REVOKE; S-02 już zrewokowało szerokie UPDATE.
- `comment on column public.meeting_invitations.responded_at is 'S-03: stamped by the respond endpoint when the invitee accepts or declines. Null while pending.'` dla potomności.

#### 2. Regeneracja typów Database

**Plik**: `src/db/database.types.ts` (regenerowany)

**Cel**: Wyeksponować nowe pole `responded_at` warstwie TypeScript, żeby endpoint API i zapytanie SSR mogły je odczytać/zapisać typowo bezpiecznie.

**Kontrakt**: Po uruchomieniu `npm run db:types`, `Database["public"]["Tables"]["meeting_invitations"]["Row"]` zawiera `responded_at: string | null`; kształty `Insert` i `Update` zawierają to samo jako opcjonalne. Nie edytować ręcznie; plik jest regenerowany mechanicznie.

#### 3. Rozszerzenie dokumentu testów RLS o bloki dla strony respond

**Plik**: `supabase/tests/meetings-rls.md` (dopisać pięć bloków numerowanych 9-13)

**Cel**: Udowodnić nową powierzchnię UPDATE od początku do końca w taki sam sposób, jak bloki 1-8 pokryły SELECT/INSERT/DELETE.

**Kontrakt** (tytuły + cel; sam dokument zawiera SQL): blok 9 — zaproszony (Bob) wykonuje UPDATE własnego oczekującego zaproszenia na `accepted` ⇒ 1 wiersz, `responded_at` not null. Blok 10 — nie-zaproszony (Dave) próbuje tego samego UPDATE ⇒ 0 wierszy (filtr USING). Blok 11 — zaproszony próbuje wykonać UPDATE już-`accepted` zaproszenia z powrotem na `declined` ⇒ 0 wierszy (filtr USING `status = 'pending'`). Blok 12 — zaproszony próbuje wykonać UPDATE zaproszenia na `status = 'expired'` ⇒ odrzucone przez WITH CHECK (ERROR: new row violates row-level security policy). Blok 13 — zaproszony próbuje wykonać UPDATE pola `invited_at` (poza kolumnowym grantem) ⇒ permission denied for table (zakres kolumnowego GRANT). Powtarza konwencję testów z friend_connections użytą w [friend-connections-rls.md](supabase/tests/friend-connections-rls.md).

### Kryteria sukcesu:

#### Weryfikacja automatyczna:

- Migracja stosuje się czysto na świeżej bazie: `npm run db:reset` zwraca 0 bez błędów.
- Typy DB regenerują się bez błędów: `npm run db:types` kończy się sukcesem; wynikowy plik zawiera `responded_at` w `meeting_invitations`.
- Type-check nadal przechodzi po regeneracji typów (kolumna jest ściśle addytywna; istniejące odczyty są niewzruszone): `npm run astro check`.
- Lint przechodzi na nowym pliku migracji (none — SQL nie jest w pipeline'ie lint; ten wiersz istnieje, żeby implementator to zauważył): brak kroku odpowiednika; zaznacz jako ukończone, jeśli plik lintuje w edytorze.

#### Weryfikacja manualna:

- Wszystkie pięć nowych bloków w `supabase/tests/meetings-rls.md` produkuje udokumentowane wyniki `expect:` przy uruchomieniu w Supabase Studio na świeżo zresetowanej lokalnej bazie.
- `\dp meeting_invitations` pokazuje `authenticated=arw/postgres` na poziomie tabeli (tylko odczyt + delete-przez-cascade; brak szerokiego zapisu — UPDATE już zrewokowane w S-02) oraz `status: authenticated=w/postgres` ORAZ `responded_at: authenticated=w/postgres` w kolumnie Column privileges.

**Implementation Note**: Po zakończeniu tej fazy i przejściu całej weryfikacji automatycznej, zatrzymaj się i poczekaj na ręczne potwierdzenie od człowieka, że testy manualne przeszły, zanim przejdziesz do kolejnej fazy.

---

## Faza 2: Okablowanie po stronie serwera

### Wprowadzenie

Dodać endpoint respond powtarzający `/api/friends/respond.ts`. Przepisać pobranie danych SSR w `/meetings.astro`, żeby ładowało oczekujące zaproszenia + połączone zapytanie spotkań (twórca-LUB-zaakceptowany-zaproszony), i obliczyć mapę konfliktów po stronie serwera. Zdefiniować współdzielone typy TypeScript dla nowych kształtów payloadu.

### Wymagane zmiany:

#### 1. Endpoint respond

**Plik**: `src/pages/api/meetings/invitations/respond.ts` (nowy)

**Cel**: Przyjąć payload `{ invitation_id, action: "accept" | "decline" }` i w jednym UPDATE supabase-js przełączyć `status` zaproszenia + ostemplować `responded_at`. Polegać na nowej polityce RLS UPDATE dla authz; mapować pudła filtra RLS na 404. Powtórzyć dosłownie kształt `/api/friends/respond.ts`.

**Kontrakt**:

- Trasa `POST`. Schemat zod: `{ invitation_id: z.string().regex(UUID_SHAPE, "invalid UUID"), action: z.enum(["accept", "decline"]) }`. Użyć tego samego wzorca stałej `UUID_SHAPE`, którego używają `/api/meetings/index.ts` i `/api/friends/respond.ts` (definiować lokalnie; nie ekstrahować jeszcze).
- Niezautentykowany → 401. Niepoprawne JSON → 400 "invalid json". Niezgodne ze schematem → 400 z wiadomością pierwszej kwestii.
- `nextStatus = parsed.data.action === "accept" ? "accepted" : "declined"`.
- Wywołanie supabase: `.from("meeting_invitations").update({ status: nextStatus, responded_at: new Date().toISOString() }).eq("id", parsed.data.invitation_id).eq("status", "pending").select("id, status, responded_at").maybeSingle()`. Defensywne `eq("status", "pending")` powtarza RLS USING; nawet gdyby polityka się rozluźniła, to gwarantuje semantykę one-shot na warstwie API.
- Błąd supabase → 500 z `error.message`. `data == null` → 404 "not found" (RLS USING odfiltrowało wiersz: nie istnieje, wywołujący nie jest zaproszonym lub status nie jest już pending).
- Sukces → 200 z `{ id, status, responded_at }`. Ten sam helper JSON co plik friend-respond.

#### 2. Przepisanie SSR w /meetings.astro

**Plik**: `src/pages/meetings.astro`

**Cel**: Zastąpić zapytanie tylko-twórca o spotkania połączonym pobraniem pokrywającym wszystkie trzy sekcje, plus obliczyć mapę konfliktów po stronie serwera i przekazać ją do komponentu oczekujących zaproszeń.

**Kontrakt**:

- Zachować istniejące pobranie `list_my_friends` (wciąż potrzebne do pickera znajomych w formularzu tworzenia).
- Zamienić pojedyncze `from("meetings").select(...).eq("creator_id", user.id)` na jedno `from("meetings").select("id, starts_at, duration_minutes, street, city, postal_code, country, description, created_at, creator:parents!creator_id(id, display_name), invitations:meeting_invitations(id, status, invited_at, responded_at, invitee:parents!invitee_id(id, display_name))").order("starts_at", { ascending: true })`. Bez `.eq("creator_id", ...)` — RLS zwraca sumę twórca-LUB-zaproszony.
- Dodać helper `endsAt(m)` we frontmatterze obliczający `new Date(m.starts_at).getTime() + m.duration_minutes * 60_000`. Używany ponownie przez mapę konfliktów i podział nadchodzące/minione.
- Obliczyć cztery wyprowadzone tablice z połączonego wyniku `meetings`:
  - `pendingInvitations` — dla każdego spotkania, gdzie któreś `invitations[i].invitee_id === user.id && invitations[i].status === 'pending'`, wyprojektować parę `{ invitation_id, meeting }`.
  - `myScheduleForConflicts` — spotkania, gdzie (a) `creator_id === user.id` LUB (b) któreś `invitations[i].invitee_id === user.id && status === 'accepted'`. Używane wyłącznie jako baza konfliktów.
  - `upcoming` — ten sam filtr co `myScheduleForConflicts`, dodatkowo `endsAt(m) >= now`, rosnąco.
  - `past` — to samo co upcoming, `endsAt(m) < now`, **malejąco** (najbardziej recent past pierwsze; posortowane po dacie, ale odwrócone dla kubełka past).
- Obliczyć `conflictsByInvitationId: Record<invitation_id, ClashingMeetingSummary[]>` przez predykat nakładania `mStart < piEnd && mEnd > piStart`, wykluczając spotkanie własne zaproszenia z bazy (i tak nie ma go w `myScheduleForConflicts`, bo zaproszenie jest pending, ale dla pewności asercja `.filter(m => m.id !== pi.meeting.id)`).
- Przekazać `pendingInvitations`, `conflictsByInvitationId`, `upcoming`, `past` i `viewerId = user.id` do komponentów Reacta.
- `loadError` i istniejący kształt `if (loadError) ... else { ... }` zostają; zmieniają się tylko zapytania w środku.

#### 3. Współdzielone typy dla nowych kształtów payloadu SSR

**Plik**: `src/components/meetings/types.ts` (nowy; albo inline-export z plików komponentów)

**Cel**: Scentralizować typy TypeScript, które strona przekazuje do nowych i przerefaktoryzowanych komponentów, żeby frontmatter strony pozostał czytelny.

**Kontrakt**: Eksportuje `MeetingRow` (połączony wiersz używany przez listę nadchodzące/minione, zawierający `creator: { id, display_name }` i `invitations: InvitationRow[]`), `InvitationRow` (z `responded_at: string | null`), `PendingInvitation` (`{ invitation_id, meeting }`) oraz `ClashingMeetingSummary` (`{ id, starts_at, duration_minutes }`). Wzorzec friends inline'uje swoje typy do każdego pliku komponentu (np. `IncomingRequest` w `IncomingRequestsList.tsx`); tu trzymać tę samą konwencję, chyba że typ jest naprawdę współdzielony między komponentami — wtedy `src/components/meetings/types.ts` jest domem. Domyślnie: inline'uj typ propsów każdego komponentu do jego własnego pliku; ekstrahuj do `types.ts` tylko, gdy dwa komponenty potrzebują tego samego kształtu (np. `MeetingRow` używany przez listę upcoming i past).

### Kryteria sukcesu:

#### Weryfikacja automatyczna:

- Type-check przechodzi: `npm run astro check` zwraca 0 z nowym kształtem SSR + nowym endpointem.
- Lint przechodzi na nowych/zmienionych plikach: `npx eslint src/pages/api/meetings/invitations/respond.ts src/pages/meetings.astro src/components/meetings/types.ts` (stosuje się postawa Windows-CRLF z [feedback memory](feedback_windows_crlf_lint.md) — tylko dotknięte ścieżki).
- Build przechodzi (runtime Cloudflare Workers wyłapuje kilka edge'owych problemów TS, które omija lint): `npm run build`.
- (Brak nowych testów jednostkowych w tym slice; weryfikacja przez macierz manualną poniżej + dokument testów RLS z Fazy 1.)

#### Weryfikacja manualna:

- Sonda curl/REST: zalogowany jako Bob, POST `/api/meetings/invitations/respond` z poprawnym `{ invitation_id, action: "accept" }` zwraca 200 z `{ id, status: "accepted", responded_at: <ISO> }`. Wiersz w DB odzwierciedla zmianę.
- Zalogowany jako Bob, POST z action `"decline"` na innym oczekującym zaproszeniu zwraca 200 z `status: "declined"`.
- Zalogowany jako Bob, POST z `invitation_id`, którego Bob nigdy nie otrzymał → 404 "not found".
- Zalogowany jako Bob, POST z już-zaakceptowanym `invitation_id` → 404 "not found" (one-shot wymuszone).
- Zalogowany jako Bob, POST z `action: "expired"` → 400 (zod enum odrzuca).
- Niezautentykowany POST → 401 "unauthorized".
- Otwarcie `/meetings` po kilku akceptach/odrzuceniach: kształt danych SSR jest poprawny (liczby pending, upcoming, past zgodne z oczekiwaniami DB; klucze `conflictsByInvitationId` pasują do ID oczekujących).

**Implementation Note**: Po zakończeniu tej fazy i przejściu całej weryfikacji automatycznej, zatrzymaj się i poczekaj na ręczne potwierdzenie od człowieka, że testy manualne przeszły, zanim przejdziesz do kolejnej fazy.

---

## Faza 3: UI + integracja

### Wprowadzenie

Przebudować `/meetings.astro` na trzy sekcje, dostarczyć `PendingInvitationsList` (nowy), zrefaktoryzować `MyMeetingsList` → `MeetingsList` (świadomy perspektywy) i odświeżyć `§Current state` w AGENTS.md, żeby odzwierciedlał wylądowanie S-03.

### Wymagane zmiany:

#### 1. Komponent PendingInvitationsList

**Plik**: `src/components/meetings/PendingInvitationsList.tsx` (nowy)

**Cel**: Wyrenderować każde oczekujące zaproszenie jako kartę z podsumowaniem spotkania (kiedy/gdzie/od-kogo/opis), inline ostrzeżeniem o konflikcie jeśli `conflictsByInvitationId[invitation_id]` jest niepusty, oraz przyciskami Akceptuj/Odrzuć powtarzającymi `IncomingRequestsList`.

**Kontrakt**:

- Props: `{ invitations: PendingInvitation[]; conflicts: Record<string, ClashingMeetingSummary[]> }`.
- Stan pusty: "No pending invitations." (powtarza słownictwo `IncomingRequestsList`).
- Układ wiersza per: góra — wyświetla starts_at spotkania (sformatowane przez `toLocaleString()`), czas trwania, podsumowanie adresu, display_name twórcy, opis. Blok konfliktu — tylko gdy `conflicts[id].length > 0`: żółta karta notice (`border-amber-400/40 bg-amber-500/10 text-amber-200`) brzmiąca "Heads up — this overlaps with: ", potem lista wypunktowana kolidujących spotkań przez `toLocaleString(starts_at)` + czas trwania. Przyciski Akceptuj (emerald, ikona `<Check>`) + Odrzuć (outline ghost, ikona `<X>`) wyrównane do prawej.
- Stan in-flight: `const [pendingId, setPendingId] = useState<string | null>(null)` powtarzający `IncomingRequestsList`. Oba przyciski disabled, gdy `pendingId === r.invitation_id`.
- Po kliknięciu: fetch `/api/meetings/invitations/respond` z `{ invitation_id, action }`. Na 2xx → `window.location.reload()`. Na błędzie → setError z polem `error` z body (fallback "Could not respond"). Catch → "Network error".
- Użyj tego samego importu `Button` z `@/components/ui/button`, tych samych ikon lucide (`Check`, `X`) i tego samego słownictwa kolorów co `IncomingRequestsList`. Bez nowych komponentów shadcn.

#### 2. Refaktor MyMeetingsList → MeetingsList (świadomy perspektywy)

**Plik**: `src/components/meetings/MyMeetingsList.tsx` → zmiana nazwy na `src/components/meetings/MeetingsList.tsx` (rename pliku); typ `MeetingWithInvitations` staje się `MeetingRow` i dostaje `creator: { id, display_name }`

**Cel**: Sprawić, żeby komponent listy obsługiwał obie perspektywy — twórcy i zaproszonego — tak by mógł renderować ujednolicone listy upcoming/past bez dwóch równoległych komponentów.

**Kontrakt**:

- Props zmieniają się z `{ meetings: MeetingWithInvitations[] }` na `{ meetings: MeetingRow[]; viewerId: string; emptyMessage?: string }`. `emptyMessage` domyślnie "No meetings here yet.", ale nadpisywany per użycie ("No upcoming meetings." / "No past meetings.").
- Gałąź per wiersz: `const isCreator = m.creator.id === viewerId`. Nagłówek summary (`<summary>`) pokazuje datę + czas trwania bez zmian. Rozwinięte body pokazuje:
  - **Gałąź twórcy** (`isCreator === true`): bez zmian względem dzisiaj — Address, Description, pełna lista Invitations z badge'ami, przycisk Delete. Licznik "accepted/total" w summary zostaje.
  - **Gałąź zaproszonego** (`isCreator === false`): Address, Description, linia "Created by `<m.creator.display_name>`" oraz badge własnego statusu widza (zawsze `accepted` dla wierszy upcoming/past, bo pending mieszka w sekcji 1; asercja i render badge'a `accepted` z `m.invitations.find(i => i.invitee_id === viewerId)`). Bez przycisku Delete.
- Przekazywanie dalej: logika delete-cascade i stan in-flight delete zostają; po prostu stają się strzeżone przez `isCreator`.
- Zaktualizować stronę importującą (`/meetings.astro`), żeby importowała `MeetingsList` z nowej ścieżki; zaktualizować import `type { MeetingRow }`. `MyMeetingsList` jest w pełni zastąpiony — bez shimu re-exportu, bez aliased importu (zgodnie z posturą repo o braku artefaktów backwards-compat).
- Uwaga dla implementatora: utrata stanu open na `<details>` przy reload to znany niuans UX; poza zakresem tutaj.

#### 3. Kompozycja /meetings.astro w trzy sekcje

**Plik**: `src/pages/meetings.astro`

**Cel**: Zamienić pojedynczą sekcję „My created meetings” na trzy: Pending invitations, Upcoming, Past. „Create new meeting” zostaje na górze.

**Kontrakt**:

- Kolejność sekcji góra-dół: header, banner błędu (istniejący), Create new meeting (istniejący), **Pending invitations**, **Upcoming meetings**, **Past meetings**.
- Każda nowa sekcja używa tej samej obwoluty `<section class="rounded-2xl border border-white/10 bg-white/10 p-6 text-white backdrop-blur-xl">` używanej dziś.
- Sekcja Pending: `<h2>Pending invitations</h2>` + `<PendingInvitationsList invitations={pendingInvitations} conflicts={conflictsByInvitationId} client:visible />`. Sekcja jest w całości ukryta, gdy `pendingInvitations.length === 0` I strona ma co najmniej jedno upcoming lub past meeting (czyli rodzic był wcześniej aktywny); w przeciwnym razie renderuje się komunikat stanu pustego.
- Sekcja Upcoming: `<h2>Upcoming meetings</h2>` + `<MeetingsList meetings={upcoming} viewerId={user.id} emptyMessage="No upcoming meetings." client:visible />`.
- Sekcja Past: `<h2>Past meetings</h2>` + `<MeetingsList meetings={past} viewerId={user.id} emptyMessage="No past meetings." client:visible />`.
- Dane SSR friend-pickera + formularz tworzenia (`<MeetingCreateForm>`) bez zmian.

#### 4. Odświeżenie §Current state w AGENTS.md

**Plik**: `AGENTS.md`

**Cel**: Zaktualizować akapit §Current state, żeby odzwierciedlał wylądowanie S-03: polityka UPDATE + kolumnowy GRANT na `(status, responded_at)` na miejscu, strona `/meetings` jest trzysekcyjna, a cron-expiry to jedyne pozostałe follow-up dla S-04. Usunąć linię „accept/decline transitions and conflict warning ship in the next slice (S-03)”, bo to już historia.

**Kontrakt**: Obecny akapit kończy się "accept/decline transitions and conflict warning ship in the next slice (S-03), cron expiry in S-04.". Po tym slice: zastąpić "Accept/decline transitions are gated by a `meeting_invitations_update` RLS policy (one-shot, `pending → accepted|declined`), and the API stamps a `responded_at` audit column via a column-level GRANT on `(status, responded_at)`. The `/meetings` page renders three sections (Pending invitations with inline conflict warning → Upcoming → Past, the latter two sourced from a unified creator-OR-accepted-invitee meetings query). Cron expiry of unanswered invitations lands in S-04." Dopasować otoczenie prozy tak, by sekcja czytała się spójnie z resztą.

### Kryteria sukcesu:

#### Weryfikacja automatyczna:

- Type-check przechodzi: `npm run astro check` zwraca 0 dla nowego komponentu, przemianowanej listy i zaktualizowanej strony.
- Lint przechodzi na dotkniętych plikach (postura Windows-CRLF): `npx eslint src/components/meetings/PendingInvitationsList.tsx src/components/meetings/MeetingsList.tsx src/pages/meetings.astro`.
- Build przechodzi: `npm run build`.

#### Weryfikacja manualna:

- Zalogowany jako Alice (twórca), `/meetings` renderuje: formularz Create na górze, pustą sekcję Pending invitations (Alice nie dostała żadnych zaproszeń w seed), jedno spotkanie Upcoming (to, które Alice utworzy jako część przepływu weryfikacyjnego), żadnych Past jeszcze.
- Utworzyć spotkanie na sobotę 14:00 zapraszając Boba. Wylogować się, zalogować jako Bob. `/meetings` renderuje: formularz Create, jedno Pending invitation (spotkanie Alice), Upcoming puste, Past puste.
- Kliknąć Akceptuj na oczekującym zaproszeniu Boba. Strona się przeładuje. Sekcja Pending teraz pusta; spotkanie pojawia się w Upcoming z nazwą twórcy „Alice” i bez przycisku Delete.
- Jako Alice utwórz drugie spotkanie na tę samą sobotę 14:00 zapraszając Boba. Zaloguj się jako Bob. `/meetings` pokazuje pending invitation z inline żółtym ostrzeżeniem o konflikcie nazywającym już-zaakceptowane spotkanie sobota 14:00. Kliknij Odrzuć. Strona się przeładuje. Gałąź odrzucenia zweryfikowana: nie jest już pending, nie pojawia się w Upcoming.
- Zaloguj się jako Alice, `/meetings` Upcoming pokazuje jedno zaakceptowane spotkanie sobota 14:00 (status per-zaproszony = accepted dla Boba na pierwszym; declined dla Boba na drugim — Alice to widzi jako twórca).
- Spotkanie z datą past (ręczny seed lub czekanie) renderuje się w sekcji Past z porządkiem malejącym.
- 404 dzieje się, gdy Bob próbuje odpowiedzieć na stronę stale po tym, jak Alice usunęła spotkanie: banner błędu pokazuje "not found" przez istniejący stan `error`.

**Implementation Note**: Po zakończeniu tej fazy i przejściu całej weryfikacji automatycznej, zatrzymaj się i poczekaj na ręczne potwierdzenie od człowieka, zanim oznaczysz slice jako zakończony.

---

## Strategia testowania

### Testy jednostkowe:

- Brak dodanych w tym slice. Postura repo z `package.json` jest taka, że nie jest skonfigurowany żaden runner testów jednostkowych; weryfikacja przepływa przez macierz manualną + dokument testów SQL + `npm run astro check` + `npm run build`. Dodanie runnera testów to sprawa Modułu 3.

### Testy integracyjne:

- Macierz end-to-end manualna w kryteriach sukcesu Fazy 3. Dwoje realnie zaseedowanych rodziców (Alice, Bob) ćwiczy ścieżki akceptacji, odrzucenia, ostrzeżenia o konflikcie i renderowania cross-perspective.

### Kroki testowania manualnego:

1. `npm run db:reset`, żeby zastosować nową migrację.
2. `npm run db:types`, żeby zregenerować typy.
3. Otwórz Supabase Studio → SQL editor i uruchom każdy z bloków 9-13 ze zaktualizowanego `supabase/tests/meetings-rls.md`. Każdy komentarz `expect:` w bloku musi pasować.
4. `npm run dev`. Zaloguj się jako Alice. Utwórz spotkanie na sobotę 14:00 zapraszając Boba. Wyloguj się.
5. Zaloguj się jako Bob. Sprawdź, że pending invitation pokazuje się bez ostrzeżenia o konflikcie. Akceptuj. Sprawdź, że trafia do Upcoming z poprawnym renderem gałęzi twórcy ("Created by Alice", bez Delete).
6. Zaloguj się jako Alice. Utwórz drugie spotkanie na sobotę 14:00 zapraszając Boba. Wyloguj się.
7. Zaloguj się jako Bob. Sprawdź, że nowe pending invitation pokazuje się z żółtym ostrzeżeniem o konflikcie nazywającym pierwsze spotkanie Alice. Odrzuć. Sprawdź, że nie trafia do Upcoming.
8. Ścieżka negatywna: w sesji Boba spróbuj POST endpointa respond z właśnie odrzuconym invitation_id → 404. Spróbuj z action = "expired" → 400.
9. Sprawdź, że AGENTS.md §Current state czyta się spójnie i odzwierciedla zmiany S-03.

## Uwagi dotyczące wydajności

- Indeks częściowy pending invitations (`meeting_invitations_invitee_pending_idx`) i indeks częściowy accepted invitations (`meeting_invitations_invitee_accepted_idx`) są na miejscu z S-02. Obie połówki pobrania SSR są zaindeksowane.
- Obliczenie mapy konfliktów to O(P × S), gdzie P = liczba pending invitations, S = harmonogram potwierdzony rodzica. Przy PRD `target_scale.users: medium` + drugorzędnym kryterium sukcesu „3 znajomych”, P × S jest komfortowo małe (< 100 × 100 = 10k operacji JS na render). Optymalizacja niepotrzebna.
- Połączone zapytanie SSR o spotkania zwraca pełną historię rodzica. Przy skali MVP jest to OK; jeśli rodzic kiedyś nazbiera >500 minionych spotkań, koszt renderu strony stanie się widoczny. Paginacja jest jawnym non-goalem tutaj; wrócić, gdy realny użytkownik dobije do tej liczby.

## Uwagi migracyjne

- Nowa migracja jest addytywna: dodaje nullable kolumnę, dodaje politykę i dodaje kolumnowy GRANT. Nie dotyka istniejących wierszy. Wiersze zaproszeń sprzed S-03 mają `responded_at = null`; to oczekiwany stan dla każdego wiersza utworzonego, zanim kolumna audytu zaistniała.
- Brak konieczności backfillu danych.
- Rollback (tylko lokalny): hipotetyczne `drop policy meeting_invitations_update on public.meeting_invitations; alter table public.meeting_invitations drop column responded_at;` cofnęłoby schemę. Brak migracji pushowanych zdalnie (zgodnie z posturą scope AGENTS.md).

## Odniesienia

- Poprzedni slice (zarchiwizowany): `context/archive/2026-05-28-meeting-creation-and-invite/plan.md` — warstwa danych S-02, którą ten slice rozszerza.
- Wzorzec friend-respond: `src/pages/api/friends/respond.ts`, `src/components/friends/IncomingRequestsList.tsx`.
- Precedens kolumnowego GRANT (REVOKE-first): `supabase/migrations/20260527103435_friend_connections_foundation.sql:65-78`.
- Helpery SELECT cross-table: `supabase/migrations/20260528105428_meetings_foundation.sql:48-94`.
- PRD: `context/foundation/prd.md` §FR-008, §FR-009, §FR-010, §Business Logic.
- AGENTS.md §Current state, §Key conventions (Column-level partial-UPDATE GRANT, Cross-table visibility, Cross-table mutation via SECURITY DEFINER RPC — ten ostatni wyjaśnia, dlaczego S-03 NIE potrzebuje RPC).

## Postęp

> Konwencja: `- [ ]` pending, `- [x]` done. Dopisać ` — <commit sha>` gdy krok ląduje. Nie zmieniać nazw kroków. Patrz `references/progress-format.md`.

### Faza 1: Warstwa danych

#### Automatyczne

- [ ] 1.1 Migracja stosuje się czysto na świeżej bazie: `npm run db:reset` zwraca 0 bez błędów
- [ ] 1.2 Typy DB regenerują się bez błędów: `npm run db:types` kończy się sukcesem; wynikowy plik zawiera `responded_at` w `meeting_invitations`
- [ ] 1.3 Type-check nadal przechodzi po regeneracji typów: `npm run astro check`

#### Manualne

- [ ] 1.4 Wszystkie pięć nowych bloków w `supabase/tests/meetings-rls.md` produkuje udokumentowane wyniki `expect:` przy uruchomieniu w Supabase Studio na świeżo zresetowanej lokalnej bazie
- [ ] 1.5 `\dp meeting_invitations` pokazuje oczekiwane granty na poziomie tabeli + kolumnowym (brak szerokiego UPDATE; `status` + `responded_at` zapisywalne dla authenticated)

### Faza 2: Okablowanie po stronie serwera

#### Automatyczne

- [ ] 2.1 Type-check przechodzi: `npm run astro check` zwraca 0 z nowym kształtem SSR + nowym endpointem
- [ ] 2.2 Lint przechodzi na dotkniętych plikach: `npx eslint src/pages/api/meetings/invitations/respond.ts src/pages/meetings.astro src/components/meetings/types.ts` (postura Windows-CRLF — tylko dotknięte ścieżki)
- [ ] 2.3 Build przechodzi: `npm run build`

#### Manualne

- [ ] 2.4 Sonda curl/REST: zalogowany jako Bob, POST `/api/meetings/invitations/respond` z poprawnym `{ invitation_id, action: "accept" }` zwraca 200 z `{ id, status: "accepted", responded_at: <ISO> }`, a wiersz DB odzwierciedla zmianę
- [ ] 2.5 Zalogowany jako Bob, POST z action `"decline"` na innym pending zwraca 200 z `status: "declined"`
- [ ] 2.6 Zalogowany jako Bob, POST z `invitation_id`, którego Bob nigdy nie otrzymał → 404 "not found"
- [ ] 2.7 Zalogowany jako Bob, POST z już-zaakceptowanym `invitation_id` → 404 "not found" (one-shot wymuszone)
- [ ] 2.8 Zalogowany jako Bob, POST z `action: "expired"` → 400 (zod enum odrzuca)
- [ ] 2.9 Niezautentykowany POST → 401 "unauthorized"
- [ ] 2.10 Otwarcie `/meetings` po kilku akceptach/odrzuceniach: kształt danych SSR jest poprawny (liczby pending, upcoming, past zgodne z oczekiwaniami DB; klucze `conflictsByInvitationId` pasują do ID oczekujących)

### Faza 3: UI + integracja

#### Automatyczne

- [ ] 3.1 Type-check przechodzi: `npm run astro check` zwraca 0 dla nowego komponentu, przemianowanej listy i zaktualizowanej strony
- [ ] 3.2 Lint przechodzi na dotkniętych plikach: `npx eslint src/components/meetings/PendingInvitationsList.tsx src/components/meetings/MeetingsList.tsx src/pages/meetings.astro`
- [ ] 3.3 Build przechodzi: `npm run build`

#### Manualne

- [ ] 3.4 Jako Alice: `/meetings` renderuje formularz Create + pustą sekcję Pending + (po utworzeniu jednego) Upcoming z renderem gałęzi twórcy
- [ ] 3.5 Jako Bob: pending invitation pokazuje się; kliknięcie Akceptuj przenosi je do Upcoming z renderem gałęzi zaproszonego ("Created by Alice", bez Delete)
- [ ] 3.6 Jako Alice: utwórz drugie spotkanie na ten sam czas zapraszając Boba. Jako Bob: pending pokazuje inline żółte ostrzeżenie o konflikcie nazywające już-zaakceptowane spotkanie. Odrzuć. Sprawdź, że nie trafia do Upcoming.
- [ ] 3.7 Jako Alice (twórca): Upcoming pokazuje status per-zaproszony odzwierciedlający akcept Boba na pierwszym spotkaniu i decline na drugim
- [ ] 3.8 Spotkanie z datą past renderuje się w sekcji Past w porządku malejącym
- [ ] 3.9 404 stale-page: Bob próbuje odpowiedzieć po tym, jak Alice usunęła spotkanie → banner błędu pokazuje "not found"
- [ ] 3.10 AGENTS.md §Current state czyta się spójnie z odzwierciedleniem S-03; linia "accept/decline … ships in S-03" jest usunięta
