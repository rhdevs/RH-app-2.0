import { createTRPCRouter, publicProcedure } from "../trpc";

export const facilityRouter = createTRPCRouter({
  getFacility: publicProcedure.query(() => {
    return [
      { name: "Alumni Room", category: "upper-lounge" },
      { name: "Band Room", category: "communal-hall" },
      { name: "Basketball Court", category: "others" },
      { name: "Comm Hall (Back)", category: "communal-hall" },
      { name: "Comm Hall (Front)", category: "communal-hall" },
      { name: "Dance Studio", category: "others" },
      { name: "Hard Court", category: "others" },
      { name: "Heritage Corner", category: "communal-hall" },
      { name: "Kuok Conf Rm", category: "kuok-foundation-house" },
      { name: "Main Area (UL)", category: "upper-lounge" },
      { name: "Meeting Room", category: "lower-lounge" },
      { name: "Pool Area", category: "lower-lounge" },
    ];
  }),
});
