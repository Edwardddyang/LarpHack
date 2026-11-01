"""Pro style archetypes.

Axis values are hand-tuned from widely known, publicly described playing styles
(commentary, coaching breakdowns), not measured motion capture. They capture
what each player is famous for so the comparison is fun and directionally right.
"""

PROS = [
    # --- Tennis ---
    {"id": "federer", "sport": "tennis", "name": "Roger Federer", "nickname": "The Maestro",
     "signature": "Effortless rhythm, quiet head, textbook economy of motion.",
     "axes": {"power": 70, "legs": 55, "coil": 65, "reach": 75, "quickness": 70, "stability": 95, "finish": 75}},
    {"id": "nadal", "sport": "tennis", "name": "Rafael Nadal", "nickname": "The Bull",
     "signature": "Lefty whip, huge topspin, relentless legs and a wrap-around finish.",
     "axes": {"power": 80, "legs": 85, "coil": 80, "reach": 55, "quickness": 55, "stability": 70, "finish": 95}},
    {"id": "djokovic", "sport": "tennis", "name": "Novak Djokovic", "nickname": "The Joker",
     "signature": "Elastic balance, compact prep and machine-like repeatability.",
     "axes": {"power": 70, "legs": 75, "coil": 70, "reach": 70, "quickness": 75, "stability": 90, "finish": 70}},
    {"id": "serena", "sport": "tennis", "name": "Serena Williams", "nickname": "The Queen",
     "signature": "Explosive leg drive and one of the most feared serves ever.",
     "axes": {"power": 95, "legs": 90, "coil": 70, "reach": 80, "quickness": 65, "stability": 75, "finish": 70}},
    {"id": "alcaraz", "sport": "tennis", "name": "Carlos Alcaraz", "nickname": "Carlitos",
     "signature": "All-out explosiveness, fast arm, athletic jumps into the ball.",
     "axes": {"power": 90, "legs": 90, "coil": 75, "reach": 70, "quickness": 85, "stability": 60, "finish": 80}},
    {"id": "sinner", "sport": "tennis", "name": "Jannik Sinner", "nickname": "The Fox",
     "signature": "Clean, early contact and flat, heavy pace off both wings.",
     "axes": {"power": 85, "legs": 65, "coil": 65, "reach": 80, "quickness": 85, "stability": 85, "finish": 60}},
    {"id": "isner", "sport": "tennis", "name": "John Isner", "nickname": "Big John",
     "signature": "Sky-high contact point and a serve built on pure reach.",
     "axes": {"power": 85, "legs": 45, "coil": 50, "reach": 98, "quickness": 50, "stability": 80, "finish": 55}},
    {"id": "kyrgios", "sport": "tennis", "name": "Nick Kyrgios", "nickname": "The Showman",
     "signature": "Abbreviated, lightning-quick service motion with minimal knee bend.",
     "axes": {"power": 90, "legs": 35, "coil": 55, "reach": 80, "quickness": 98, "stability": 70, "finish": 50}},
    {"id": "roddick", "sport": "tennis", "name": "Andy Roddick", "nickname": "A-Rod",
     "signature": "Short, explosive service windup with a violent arm.",
     "axes": {"power": 98, "legs": 70, "coil": 60, "reach": 70, "quickness": 95, "stability": 60, "finish": 55}},
    {"id": "swiatek", "sport": "tennis", "name": "Iga Swiatek", "nickname": "The Polish Prodigy",
     "signature": "Heavy topspin forehand, big shoulder turn, aggressive court position.",
     "axes": {"power": 75, "legs": 80, "coil": 85, "reach": 60, "quickness": 70, "stability": 75, "finish": 90}},
    {"id": "gauff", "sport": "tennis", "name": "Coco Gauff", "nickname": "Coco",
     "signature": "Elite athleticism and leg drive, with a big first serve.",
     "axes": {"power": 85, "legs": 85, "coil": 65, "reach": 75, "quickness": 70, "stability": 65, "finish": 70}},
    {"id": "medvedev", "sport": "tennis", "name": "Daniil Medvedev", "nickname": "The Octopus",
     "signature": "Long levers, flat strokes and unorthodox, deep-court defense.",
     "axes": {"power": 75, "legs": 50, "coil": 55, "reach": 90, "quickness": 60, "stability": 85, "finish": 50}},
    {"id": "zverev", "sport": "tennis", "name": "Alexander Zverev", "nickname": "Sascha",
     "signature": "Tall frame, high contact point and a heavy first serve.",
     "axes": {"power": 90, "legs": 60, "coil": 60, "reach": 92, "quickness": 60, "stability": 80, "finish": 60}},
    # --- Pickleball ---
    {"id": "johns", "sport": "pickleball", "name": "Ben Johns", "nickname": "The GOAT",
     "signature": "Precise, compact mechanics and total control at the kitchen line.",
     "axes": {"power": 65, "legs": 60, "coil": 55, "reach": 70, "quickness": 80, "stability": 95, "finish": 60}},
    {"id": "waters", "sport": "pickleball", "name": "Anna Leigh Waters", "nickname": "ALW",
     "signature": "Aggressive drives, lightning hands and a two-handed backhand.",
     "axes": {"power": 85, "legs": 70, "coil": 75, "reach": 60, "quickness": 90, "stability": 75, "finish": 70}},
    {"id": "mcguffin", "sport": "pickleball", "name": "Tyson McGuffin", "nickname": "The Pickleball Beast",
     "signature": "Intense, athletic, all-gas power game.",
     "axes": {"power": 90, "legs": 85, "coil": 70, "reach": 65, "quickness": 75, "stability": 55, "finish": 80}},
    {"id": "staksrud", "sport": "pickleball", "name": "Federico Staksrud", "nickname": "Fede",
     "signature": "Big-swing forehand drive and relentless athletic defense.",
     "axes": {"power": 88, "legs": 80, "coil": 85, "reach": 70, "quickness": 65, "stability": 65, "finish": 85}},
    {"id": "jwjohnson", "sport": "pickleball", "name": "JW Johnson", "nickname": "JW",
     "signature": "Quick-twitch hands and fearless speed-ups.",
     "axes": {"power": 75, "legs": 70, "coil": 60, "reach": 65, "quickness": 95, "stability": 70, "finish": 55}},
    {"id": "parenteau", "sport": "pickleball", "name": "Catherine Parenteau", "nickname": "CP",
     "signature": "Smooth, patient soft game with clean, repeatable strokes.",
     "axes": {"power": 55, "legs": 60, "coil": 50, "reach": 70, "quickness": 60, "stability": 95, "finish": 75}},
]

BY_ID = {p["id"]: p for p in PROS}


def pros_for(sport: str) -> list[dict]:
    return [p for p in PROS if p["sport"] == sport]
