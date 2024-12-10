## Contribution Guidelines

Thank you for considering contributing to RHApp! This document outlines the process for contributing to the project, ensuring a consistent and efficient development workflow.

---

### **How to Contribute**

1. **Work Directly on the Repository**:

   - Ensure you have the necessary permissions to work on the repository.

2. **Implement Your Changes**:

   - Make the desired changes to the codebase in a separate branch.
   - Ensure your code adheres to the project's style guide.

3. **Run Tests**:

   - To be set up
   - Verify that your changes do not break any functionality:
     ```bash
     npm run test
     ```

4. **Commit Your Changes**:

   - Write clear and concise commit messages. Use the [Conventional Commits](https://www.conventionalcommits.org/) format:
     ```bash
     git commit -m "feat: Add booking conflict prevention logic"
     ```

5. **Review Your Changes**:
   - Create a pull request for your changes onto the `main` branch:

---

### **Code Style**

- Follow [Prettier](https://prettier.io/) for consistent formatting.
- Ensure meaningful variable and function names.
- Use comments to explain complex logic.

---

### **Pull Request Guidelines**

- Ensure all existing and new tests pass before opening a pull request.
- Describe your changes clearly in the pull request description.
- Link the related issue(s) (if any) using keywords like `Fixes #123`.

---

### **Commit Message Format**

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for commit messages:

- **feat**: A new feature.
- **fix**: A bug fix.
- **docs**: Documentation-only changes.
- **style**: Changes that do not affect the meaning of the code (e.g., formatting).
- **refactor**: Code changes that neither fix a bug nor add a feature.
- **test**: Adding missing tests or correcting existing tests.
- **chore**: Changes to the build process or auxiliary tools.

Examples:

```plaintext
feat: Add calendar view for booking management
fix: Resolve issue with overlapping facility bookings
docs: Update README with API usage examples
```
