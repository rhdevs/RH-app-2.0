import { useState } from "react";

interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

const usePasswordValidation = (password: string) => {
  const [validationResult, setValidationResult] = useState<ValidationResult>({
    isValid: false,
    errors: [],
  });

  const validatePassword = () => {
    const errors: string[] = [];
    if (password.length < 8) {
      errors.push("Password must be at least 8 characters long.");
    }
    if (!/[A-Z]/.test(password)) {
      errors.push("Password must contain at least one uppercase letter.");
    }
    if (!/[a-z]/.test(password)) {
      errors.push("Password must contain at least one lowercase letter.");
    }
    if (!/[0-9]/.test(password)) {
      errors.push("Password must contain at least one number.");
    }
    if (!/[!@#$%^&*]/.test(password)) {
      errors.push("Password must contain at least one special character.");
    }

    setValidationResult({
      isValid: errors.length === 0,
      errors,
    });
  };

  return { validationResult, validatePassword };
};

export default usePasswordValidation;
