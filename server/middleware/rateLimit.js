import rateLimit from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many login attempts. Please try again after 15 minutes.",
  },
});

export const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !!req.doctor,
  message: { error: "Too many requests. Please try again later." },
});

export const userLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  keyGenerator: (req) => `user_${req.doctor?.doctor_id}`,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.doctor,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  message: { error: "Too many requests. Please slow down." },
});
