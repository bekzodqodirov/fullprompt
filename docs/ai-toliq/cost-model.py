# Cost model for the target AI seller. $/MTok.
S5 = dict(i=2, o=10, r=0.2, w=2.5)      # code: MODEL_USD_PER_MTOK[claude-sonnet-5]
O5 = dict(i=5, o=25, r=0.5, w=6.25)     # code: MODEL_USD_PER_MTOK[claude-opus-5]
H55 = dict(i=0.10, o=0.50, r=0.01, w=0.125)  # OUTSIDE the code: provider list (<=100K prompt); cache rates assumed 0.1x/1.25x
M = 1e6

def run(p, H, C, rounds, out_tool=300, out_final=800, tail_step=600, cold=False):
    """one agent run: head H cached, chat block C written round 1 and read after, tail grows tail_step per finished round (uncached)."""
    c = 0.0
    for k in range(rounds):
        c += H * (p['w'] if (cold and k == 0) else p['r'])
        c += C * (p['w'] if k == 0 else p['r'])
        c += (100 + tail_step * k) * p['i']
        c += (out_final if k == rounds - 1 else out_tool) * p['o']
    return c / M

H = 12000
for C in (2000, 3500, 8000):
    a1 = run(S5, H, C, 1); a2 = run(S5, H, C, 2); b = run(S5, H, C, 4, out_final=1100)
    print(f"C={C}: a1={a1:.4f} a2={a2:.4f} b={b:.4f}  cold: a1={run(S5,H,C,1,cold=True):.4f} a2={run(S5,H,C,2,cold=True):.4f} b={run(S5,H,C,4,out_final=1100,cold=True):.4f}")
print("today head 8k: a2", round(run(S5, 8000, 2000, 2), 4), "cold", round(run(S5, 8000, 2000, 2, cold=True), 4))
print("worst case 6 rounds, 8k chat, full outputs 1500:", round(run(S5, H, 8000, 6, out_tool=1500, out_final=1500), 4))
print("opus writer a2 warm/cold C=3.5k:", round(run(O5, H, 3500, 2), 4), round(run(O5, H, 3500, 2, cold=True), 4),
      " b warm/cold:", round(run(O5, H, 3500, 4, out_final=1100), 4), round(run(O5, H, 3500, 4, out_final=1100, cold=True), 4))

def review(p, head=2000, ctx=1600, out=300, tok=1.0):
    return tok * (head * p['r'] + ctx * p['i'] + out * p['o']) / M
rv_h = review(H55, tok=1.3); rv_s = review(S5); rv_o = review(O5, out=500)
print(f"reviewer per turn: haiku={rv_h:.5f} sonnet={rv_s:.4f} opus={rv_o:.4f}")
rewrite_round = (H * S5['r'] + 3500 * S5['r'] + 2500 * S5['i'] + 900 * S5['o']) / M
print("rewrite round", round(rewrite_round, 4))

# media
photo_s = (3050 * S5['i'] + 400 * S5['o']) / M
photo_s_small = (1870 * S5['i'] + 400 * S5['o']) / M
photo_o = (3050 * O5['i'] + 800 * O5['o']) / M
print(f"photo read once: sonnet {photo_s:.4f}, sonnet 1280px {photo_s_small:.4f}, opus {photo_o:.4f}")
print("photo kept in context per extra round uncached:", 2750 * S5['i'] / M, " per run if cached:", 2750 * S5['w'] / M)
doc_s = (5000 * S5['i'] + 3500 * S5['o']) / M
doc_o_lo = (5000 * O5['i'] + 3000 * O5['o']) / M; doc_o_hi = (5000 * O5['i'] + 10000 * O5['o']) / M; doc_o_typ = (5000*O5['i'] + 6000*O5['o'])/M
doc_o_max = (5000 * O5['i'] + 32000 * O5['o']) / M
intake_typ = (20500 * O5['i'] + 9000 * O5['o']) / M; intake_max = (70000 * O5['i'] + 32000 * O5['o']) / M
print(f"doc: sonnet {doc_s:.3f}; opus {doc_o_lo:.3f}-{doc_o_hi:.3f} typ {doc_o_typ:.3f} max {doc_o_max:.3f}; multi-file intake typ {intake_typ:.3f} max {intake_max:.3f}")

def conv(T, variant, hit, stt_per_min=0.006):
    C = 2000 if T == 6 else 3500
    nb = T // 3; na = T - nb
    cold_pen = H * (S5['w'] - S5['r']) / M
    a1 = run(S5, H, C, 1); a2 = run(S5, H, C, 2); b = run(S5, H, C, 4, out_final=1100)
    parts = {}
    turns = T
    writer = nb * b + na * (a1 + a2) / 2
    # voice: 30% of conversations, 2 notes x 30 s, one extra read-back turn
    voice_stt = 0.30 * 1.0 * stt_per_min
    voice_turn = 0.30 * a1
    turns_eff = T + 0.30
    # proactive: 0.5 follow-up per conversation
    follow = 0.5 * a2
    turns_eff += 0.5
    cold = turns_eff * (1 - hit) * cold_pen
    if variant == 'spec':
        rv = turns_eff * (rv_s + 0.10 * rv_o + 0.08 * (rewrite_round + rv_s))
        photo = 0.40 * 2 * photo_s
        doc = 0.20 * doc_o_typ
        opus_writer = 0
    elif variant == 'lean':
        rv = turns_eff * (rv_h + 0.05 * rv_o + 0.08 * (rewrite_round + rv_h))
        photo = 0.40 * 2 * photo_s_small
        doc = 0.20 * (0.4 * 0 + 0.5 * doc_s + 0.1 * doc_o_typ)
        opus_writer = 0
    elif variant == 'heavy':
        rv = turns_eff * (rv_o + 0.08 * (rewrite_round + rv_o))
        # images re-sent every round for the remaining half of the conversation, 2 photos, avg 2.5 rounds/turn, uncached
        photo = 0.40 * 2 * (T / 2) * 2.5 * 2750 * S5['i'] / M
        doc = 0.20 * intake_typ
        # 20% of turns on opus, cold
        opus_writer = 0.20 * T * (run(O5, H, C, 2, cold=True) - (a1 + a2) / 2)
    prefill = 0.10 * 0.15
    parts = dict(writer=writer, cold=cold, reviewer=rv, photo=photo, doc=doc, voice=voice_stt + voice_turn, follow=follow, prefill=prefill, opus_writer=opus_writer)
    return parts

hits = {20: 0.70, 60: 0.90, 150: 0.97}
for variant in ('lean', 'spec', 'heavy'):
    print("\n==", variant)
    for T in (6, 12):
        for n in (20, 60, 150):
            p = conv(T, variant, hits[n])
            tot = sum(p.values())
            print(f"T={T:2d} n={n:3d}: $/conv {tot:.3f}  day {tot*n:7.2f}  month {tot*n*30:8.0f}  won@10% {tot/0.10:5.2f}  won@20% {tot/0.20:5.2f}   | " + " ".join(f"{k}={v:.3f}" for k, v in p.items()))
# STT sensitivity x5
for T in (6, 12):
    p1 = sum(conv(T, 'spec', 0.9).values()); p5 = sum(conv(T, 'spec', 0.9, stt_per_min=0.03).values())
    print(f"STT x5: T={T} {p1:.3f} -> {p5:.3f}")
# output x2 sensitivity (thinking)
def conv_out2(T):
    C = 2000 if T == 6 else 3500
    nb = T // 3; na = T - nb
    a1 = run(S5, H, C, 1, out_final=1600); a2 = run(S5, H, C, 2, out_tool=600, out_final=1600); b = run(S5, H, C, 4, out_tool=600, out_final=2200)
    return nb * b + na * (a1 + a2) / 2
for T in (6, 12):
    base = conv(T, 'spec', 0.9)['writer']
    print(f"writer output x2: T={T} {base:.3f} -> {conv_out2(T):.3f}")
# today: runs at 8k head
print("today per run 8k head warm a1/a2/b:", round(run(S5, 8000, 2000, 1), 4), round(run(S5, 8000, 2000, 2), 4), round(run(S5, 8000, 2000, 4, out_final=1100), 4))
# counted tokens per run for daily_token_cap (input+output+cache_write; reads free)
def counted(C, rounds, out_tool=300, out_final=800, tail_step=600, cold=False):
    t = C + (12000 if cold else 0)
    for k in range(rounds):
        t += 100 + tail_step * k
        t += out_final if k == rounds - 1 else out_tool
    return t
print("counted tokens per run: a1", counted(2000, 1), "a2", counted(2000, 2), "b", counted(3500, 4, out_final=1100), "cold a2", counted(2000, 2, cold=True))

print("\n-- extras")
# full sale with everything present (12 turns, doc, 2 photos, voice, VED job), warm 90%
for variant in ('lean', 'spec', 'heavy'):
    p = conv(12, variant, 0.90)
    full = p['writer'] + p['cold'] + p['reviewer'] + p['opus_writer'] + p['photo'] / 0.40 + p['doc'] / 0.20 + p['voice'] / 0.30 + p['follow'] + 0.15
    print(variant, "full sale:", round(full, 2))
# all-in per turn and the send-cap ceiling
for T in (6, 12):
    for variant in ('lean', 'spec'):
        tot = sum(conv(T, variant, 0.90).values())
        print(variant, T, "all-in per turn", round(tot / T, 4), " 80 turns", round(80 * tot / T, 2), " 200 turns", round(200 * tot / T, 2))
# capacity of a budget
for B in (10, 25, 50):
    print(B, "spec short/long:", round(B / sum(conv(6, 'spec', 0.9).values())), round(B / sum(conv(12, 'spec', 0.9).values())),
          " lean:", round(B / sum(conv(6, 'lean', 0.9).values())), round(B / sum(conv(12, 'lean', 0.9).values())))
# reviewer per turn by policy
print("review/turn: haiku-all", round(rv_h + 0.05 * rv_o + 0.08 * (rewrite_round + rv_h), 4), "sonnet-all+opus10%", round(rv_s + 0.10 * rv_o + 0.08 * (rewrite_round + rv_s), 4),
      "opus-all", round(rv_o + 0.08 * (rewrite_round + rv_o), 4), "sonnet on 35%", round(0.35 * (rv_s + 0.08 * (rewrite_round + rv_s)), 4), "opus on 35%", round(0.35 * (rv_o + 0.08 * (rewrite_round + rv_o)), 4))
# deltas per day at 60 conv x 12 turns
d = lambda a, b, k: (conv(12, a, 0.9)[k] - conv(12, b, 0.9)[k]) * 60
print("per day @60x12: reviewer heavy-lean", round(d('heavy', 'lean', 'reviewer'), 1), " spec-lean", round(d('spec', 'lean', 'reviewer'), 1), " opus writer", round(conv(12, 'heavy', 0.9)['opus_writer'] * 60, 1),
      " docs heavy-lean", round(d('heavy', 'lean', 'doc'), 1), " spec-lean", round(d('spec', 'lean', 'doc'), 1), " photos heavy-lean", round(d('heavy', 'lean', 'photo'), 1), " output x2", round((conv_out2(12) - conv(12, 'spec', 0.9)['writer']) * 60, 1))
print("cold per day @20x12 (70% hit):", round(conv(12, 'spec', 0.7)['cold'] * 20, 2), " 1h-TTL writes 16/day:", round(16 * 12000 * 4 / 1e6, 2), " keep-alive pings 13/h x14h:", round(13 * 14 * 12000 * 0.2 / 1e6, 2))
# counted tokens/day vs 3M cap ; runs/day vs 150 cap
for n in (20, 60, 150):
    for T in (6, 12):
        runs = n * T
        tokens = runs * (2 / 3 * 3400 + 1 / 3 * 9500) + runs * (1 - hits[n]) * 12000
        print(f"n={n} T={T}: runs/day {runs}  counted tokens {tokens/1e6:.1f}M")
# replay cost
print("replay 200 chats x 8 turns:", round(200 * 8 * sum(conv(6, 'spec', 0.97).values()) / 6, 0), " corpus 1201 through reviewer sonnet/opus:", round(1201 * rv_s, 1), round(1201 * rv_o, 1))
