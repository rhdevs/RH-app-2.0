<!--
layout: default.md
title: "Developer Guide"
pageNav: 3
---
-->

# HallPointer Developer Guide

<!-- * Table of Contents -->
<page-nav-print />

---

## **Acknowledgements**

Libraries used: [JavaFX](https://openjfx.io/), [Jackson](https://github.com/FasterXML/jackson), [JUnit5](https://github.com/junit-team/junit5).\
This project is based on the AddressBook-Level3 project created by the [SE-EDU initiative](https://se-education.org).

---

## **Setting up, getting started**

Refer to the guide [_Setting up and getting started_](SettingUp.md).

---

## **Design**

### Architecture

<puml src="diagrams/ArchitectureDiagram.puml" width="280" />

The **_Architecture Diagram_** given above explains the high-level design of the application.

Given below is a quick overview of the main components of the application and how they interact with each other.

**Main components of the architecture**

**`Main`** (consisting of classes [`Main`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/Main.java) and [`MainApp`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/MainApp.java)) is in charge of the application launch and shut down.

- At application launch, it initializes the other components in the correct sequence, and connects them up with each other.
- At shut down, it shuts down the other components and invokes cleanup methods where necessary.

[**`Commons`**](#common-classes) represents a collection of classes used by multiple other components, and the corresponding classes are in the `hallpointer.address.commons` package.

The bulk of the application's work is done by the following four components:

- [**`UI`**](#ui-component): The user interface of the app.
- [**`Logic`**](#logic-component): Handles parsing and executing the commands received through user input.
- [**`Model`**](#model-component): Holds the data of the application in memory.
- [**`Storage`**](#storage-component): Reads data from, and writes data to the hard disk.

**How the architecture components interact with each other**

The _Sequence Diagram_ below shows how the components interact with each other when the user issues the command `delete_member 1`.

<puml src="diagrams/ArchitectureSequenceDiagram.puml" width="574" />

Each of the four main components (also shown in the diagram above) has these properties:

- It defines its _API_ (Application Programming Interface) in an `interface` with the same name as the Component.
- It implements its functionality using a concrete `{Component Name}Manager` class (which follows the corresponding API `interface` mentioned above).

For example, the `Logic` component defines its API in the `Logic.java` interface and implements its functionality using the `LogicManager.java` class which follows the `Logic` interface. Other components interact with a given component through its interface rather than the concrete class (to prevent outside components being coupled to the concrete implementation of a component), as illustrated in the partial class diagram below.

<puml src="diagrams/ComponentManagers.puml" width="300" />

While the `Storage` component provides an abstraction layer for persistent data, it also exposes access to specific data structures, such as `ReadOnlyHallPointer` and `UserPrefs`. This design balances abstraction with the need for practical access to certain data classes critical to the application’s functionality.

Ideally, the `Storage` interface would fully abstract storage details by exposing methods like `getHallPointerData()` or `getUserPreferences()`, thus hiding specifics like `ReadOnlyHallPointer`. However, for simplicity and to meet the application’s needs, `Storage` directly returns these specific data structures.

The sections below give more details about each component.

### UI component

The **API** of this component is specified in [`Ui.java`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/ui/Ui.java), and a partial but representative class diagram thereof is shown below.

<puml src="diagrams/UiClassDiagram.puml" alt="Structure of the UI Component"/>

The UI consists of a `MainWindow` that is made up of various parts like `CommandBox`, `ResultDisplay`, `MemberListPanel`, `StatusBarFooter` and so on. All these, including the `MainWindow`, inherit from the abstract `UiPart` class which captures the commonalities between classes that represent parts of the visible GUI.

The `UI` component uses the JavaFX UI framework. The layout of these UI parts are defined in matching `.fxml` files that are in the `src/main/resources/view` folder. For example, the layout of the [`MainWindow`](https://ay2425s1-cs2103t-w14-3.github.io/tree/master/src/main/java/hallpointer/address/ui/MainWindow.java) is specified in [`MainWindow.fxml`](https://ay2425s1-cs2103t-w14-3.github.io/tree/master/src/main/resources/view/MainWindow.fxml).

The `UI` component has the following responsibilities:

- Passing user commands to the `Logic` component using its reference thereof, so that the commands can be parsed and executed.
- Keeping the display up to date with `Model` data, by listening for changes in `Model` data to update the display when appropriate.

It also depends on some classes in the `Model` component like the `Member` or `Session` classes, the details of which inform what sort of visual layout is appropriate.

### Logic component

**API** : [`Logic.java`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/logic/Logic.java)

Here's a representative class diagram of the `Logic` component:

<puml src="diagrams/LogicClassDiagram.puml" width="550"/>

The sequence diagram below illustrates the interactions within the `Logic` component, taking an API call `execute("delete_member 1")` as an example.

<puml src="diagrams/DeleteSequenceDiagram.puml" alt="Interactions Inside the Logic Component for the `delete 1` Command" />

<box type="info" seamless>

**Note:** The lifeline for `DeleteMemberCommandParser` should end at the destroy marker (X) but due to a limitation of PlantUML, the lifeline continues till the end of diagram.

</box>

How the `Logic` component works:

1. When `Logic` is called upon to execute a command, the API call is passed to an `HallPointerParser` object, which in turn creates a parser that matches the command (e.g. `DeleteMemberCommandParser`) and uses it to parse the command.
2. This results in a `Command` object (more precisely, an object of one of its subclasses e.g. `DeleteMemberCommand`) being created, which is then executed by the `LogicManager`.
3. The `Command` communicates with the `Model` when it is executed (e.g. to delete a member).<br>
   Note that although this is shown as a single step in the diagram above (for simplicity), in the code it can take several interactions (between the command object and the `Model`) to achieve.
4. The result of the command execution is encapsulated as a `CommandResult` object which is then returned by `Logic`.

Here are the other classes in `Logic` (omitted from the class diagram above) that are used for parsing a user command:

<puml src="diagrams/ParserClasses.puml" width="600"/>

How the parsing works:

- When called upon to parse a user command, the `HallPointerParser` class creates an `XYZCommandParser` (where `XYZCommandParser` is a placeholder for the specific `Command` parser class that matches the API call e.g. `AddMemberCommandParser`). This newly created `Parser` then parses the user command, creating and returning a `XYZCommand` object (e.g. `AddMemberCommand`) as a `Command` object.
- All `XYZCommandParser` classes (e.g. `AddMemberCommandParser`, `DeleteSessionCommandParser`, ...) inherit from the `Parser` interface so that they can be treated similarly where possible, making adding more commands and further testing easier.

### Model component

**API** : [`Model.java`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/model/Model.java)

Here's a representative class diagram of the `Model` component:

<puml src="diagrams/ModelClassDiagram.puml" width="450" />

The `Model` component has the following responsibilites:

- Storing the HallPointer data (i.e. any `Member` and `Session` objects) in memory for easy access.
- Storing the currently 'selected' `Member` objects (e.g. the results of a search query) in a separate _filtered_ list, one which is exposed to outsiders as an unmodifiable `ObservableList<Member>` that can be 'observed'. This allows the UI to observe the list and automatically update when the data in the list changes.
- Storing a `UserPref` object that represents the user’s preferences, and exposing it to the outside as a `ReadOnlyUserPref` object.

It does not depend on any of the other three components, as the `Model` represents data entities of the application and domain, and thus should make sense on its own without depending on other components.

### Storage component

**API** : [`Storage.java`](https://github.com/AY2425S1-CS2103T-W14-3/tp/blob/master/src/main/java/hallpointer/address/storage/Storage.java)

Here's a representative class diagram of the `Storage` component:

<puml src="diagrams/StorageClassDiagram.puml" width="550" />

The `Storage` component has the following responsibilities:

- Saving HallPointer data and user preferences data to disk in JSON format.
- Parsing the saved JSON data back into the corresponding objects when the application is re-opened.

It inherits from both `Storage` and `UserPrefStorage`, allowing it to be treated as either one, depending on the functionality needed.

It depends on some classes in the `Model` component, as its job is to save and retrieve objects that belong to the `Model`.

---

## **Documentation, logging, testing, configuration, dev-ops**

- [Documentation guide](Documentation.md)
- [Testing guide](Testing.md)
- [Logging guide](Logging.md)
- [Configuration guide](Configuration.md)
- [DevOps guide](DevOps.md)

---

## **Appendix: Requirements**

### Product scope

**Target user profile**:

- is a CCA leader in a NUS Hall
- is responsible for managing member participation, tracking attendance, and allocating points
- prefers streamlined solutions to minimize manual administrative work
- comfortable with both desktop applications and command-line interfaces (CLI)
- often managing multiple responsibilities, including academic workload and hall duties

**Value proposition**: Hall Pointer empowers CCA leaders in NUS Halls to efficiently manage member tracking by streamlining participation recording, points allocation, and member information (such as room addresses). It simplifies manual data management, allowing leaders to focus on organizing activities rather than administrative tasks. Ideal for small, close-knit CCAs, it ensures quick access to updated information, enabling accurate and easy sharing of participation records with hall management or other stakeholders.

### User stories

Priorities: High (must have) - `* * *`, Medium (nice to have) - `* *`, Low (unlikely to have) - `*`

| Priority | As a …​         | I want to …​                                                     | So that I can …​                                                          | Remarks/Notes                                         |
| -------- | --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `* * *`  | First-time user | Explore the application using sample data                        | I can understand its features without manually entering data              |                                                       |
| `* * *`  | First-time user | See a guide on how to use the application                        | I can better understand its functionalities                               |                                                       |
| `* * *`  | First-time user | Save the changes I made                                          | I won’t have to redo my work after reopening the application              |                                                       |
| `* * *`  | First-time user | See sample data with a predefined structure                      | I have a format to follow when inputting my own data                      |                                                       |
| `* * *`  | First-time user | Delete all data in the application                               | I can start over when I make a mistake and remove sample data             |                                                       |
| `* * *`  | User            | Add new Hall members to the application                          | I can track points for new Hall members                                   |                                                       |
| `* * *`  | User            | Delete ex-Hall members from the application                      | I can stop tracking points for ex-Hall members                            |                                                       |
| `* * *`  | User            | Customize point allocation criteria between sessions             | I can reward members based on different participation weightage criteria  | E.g. different point weights for different activities |
| `* * *`  | Frequent user   | Adjust attendance records if there are any errors                | I can fix mistakes and maintain accurate records                          |                                                       |
| `* * *`  | User            | Update member details (e.g. name, contact)                       | I can keep the member database up to date and fix any mistakes            |                                                       |
| `* *`    | Frequent user   | Automatically track attendance at each session                   | I don't need to manually mark attendance for each session                 | Can be done by QR code generation and integration     |
| `* *`    | Frequent user   | See a breakdown of points for each member quickly                | I can monitor attendance records without excessive hassle                 |                                                       |
| `* *`    | Frequent user   | Export attendance data                                           | I can share participation reports with other stakeholders if needed       |                                                       |
| `* *`    | User            | Bulk update attendance or points for multiple members            | I can efficiently manage large groups                                     |                                                       |
| `* *`    | User            | Set up custom attendance categories (e.g. Excused, Late)         | I can categorize different types of attendance                            |                                                       |
| `*`      | User            | View analytics or visual reports of attendance and participation | I can see trends and member engagement at a glance                        | Through charts or graphs to visualize data            |
| `*`      | User            | Sort members by name                                             | I can locate a member easily                                              |                                                       |
| `*`      | Frequent user   | Automatically save changes as changes are made                   | I don’t lose progress if I forget to click save                           |                                                       |
| `*`      | Expert user     | Perform all actions using the CLI                                | I can interact with the application more efficiently than with just a GUI |                                                       |
| `*`      | User            | Add notes for each member                                        | I can track special situations or reasons for absences                    |                                                       |
| `*`      | First-time user | Import data from an existing Google Sheets document or CSV file  | I can quickly upload my previous data without manual entry                |                                                       |

### Use cases

#### Use Case: UC01 - Add Member to CCA

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to add a new member to the CCA for attendance tracking and point allocation.

**Preconditions**:

1. The CCA Leader must know the details of the new member.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `add_member` command with required details (name, room number, telegram and tags (optional)).
   - Example: `add_member n/John Doe r/4-3-301 t/johndoe123 tag/logistics`
2. Hall Pointer validates the entered details for the new member.
3. Hall Pointer adds the member to the system and displays a success message.
4. The new member is displayed in the GUI.
   - Use case ends.

**Extensions**:

- **2a. Hall Pointer detects an error in the entered data**.

  - 2a1. Hall Pointer displays an error message with relevant details.
  - 2a2. CCA Leader re-enters corrected data.
  - Steps 2a1-2a2 are repeated until the input is valid.
  - Use case resumes from step 3.

- **2b. The member to be added is already present in the system**.
  - 2b1. Hall Pointer displays an error message: `This member already exists in the CCA system.`
    - Use case ends.

---

#### Use Case: UC02 - Add Session to Hall Pointer

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to add a new CCA session to the system for tracking attendance and point allocation.

**Preconditions**:

1. The CCA Leader must know the details of the session such as name, date, points and associated members.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `add_session` command with session details (session_name, date, and points, member_index).
   - Example: `add_session s/Rehearsal d/24 Oct 2024 p/2 m/1`
2. Hall Pointer validates the entered session details.
3. Hall Pointer adds the session to the associated members and displays a success message.
4. The new session is displayed in the GUI.
   - Use case ends.

**Extensions**:

- **2a. Hall Pointer detects an error in the entered data**.

  - 2a1. Hall Pointer displays an error message with relevant details.
  - 2a2. CCA Leader re-enters corrected data.
  - Steps 2a1-2a2 are repeated until all data is correct.
  - Use case resumes from step 3.

- **2b. The session to be added is already present in at least one of the relevant members**.
  - 2b1. Hall Pointer displays an error message: `Error: Session already exists.`
    - Use case ends.

---

#### Use Case: UC03 - Update Member Information

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to update the details of an existing member, such as room number, telegram, or tags.

**Preconditions**:

1. The member to be updated must exist in the system.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `update_member` command with the member index and new details.
   - Example: `update_member 1 n/John Doe r/9/10/203 t/johnDoe123 tag/friend`
2. Hall Pointer validates the member and new details.
3. Hall Pointer updates the member information and displays a success message.
   - `Member John Doe; Telegram: johnDoe123; Room: 9/10/203; Tags: [friend]'s details updated successfully.`
4. The updated member information is displayed in the GUI.
   - Use case ends.

**Extensions**:

- **2a. Member index is invalid**.
  - 2a1. Hall Pointer displays an error message:
    - `Error: Invalid index specified.`
    - Use case ends.

---

#### Use Case: UC04 - View All Members

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to view a list of all members in the system.

**Preconditions**:
None.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `list` command.
2. Hall Pointer retrieves and displays all members in the GUI.
   - Use case ends.

---

#### Use Case: UC05 - Delete Member from CCA

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to remove a member from the CCA, ceasing attendance tracking and point allocation for the deleted member.

**Preconditions**:

1. The member to be deleted must exist in the system.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `delete_member` command with the member index.
   - Example: `delete_member 2`
2. Hall Pointer verifies the existence of the member at the specified index.
3. Hall Pointer removes the member from the system and displays a success message.
4. The updated member list is displayed in the GUI.
   - Use case ends.

**Extensions**:

- **2a. Invalid member index**.
  - 2a1. Hall Pointer displays an error message:
    - `Error: Invalid index specified.`
    - Use case ends.

---

#### Use Case: UC06 - Delete Session from Hall Pointer

**System**: Hall Pointer Application

**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to delete a CCA session from the system, removing any attendance records and points associated with that session.

**Preconditions**:

1. The session to be deleted must exist in the system.

**Main Success Scenario (MSS)**:

1. CCA Leader inputs the `delete_session` command with the session name and associated member indexes.
   - Example: `delete_session s/Rehearsal m/1 m/3`
2. Hall Pointer verifies the existence of the session in the records of the specified members.
3. Hall Pointer deletes the session from the system and displays a success message.
4. The updated session list is displayed in the GUI.
   - Use case ends.

**Extensions**:

- **2a. Session does not exist for specified members**.

  - 2a1. Hall Pointer displays an error message:
    - `Error: Session [session_name] does not exist in member [member_name].`
  - Use case ends.

- **2b. Incorrect session or member index provided**.
  - 2b1. Hall Pointer displays an error message:
    - `Error: Invalid index specified.`
  - Use case ends.

### Non-Functional Requirements

1. Should work on any _mainstream OS_ as long as it has Java `17` or above installed.
2. Should be able to hold up to 1000 members without a noticeable sluggishness in performance for typical usage.
3. A user with above-average typing speed for regular English text (i.e. not code, not system admin commands) should be able to accomplish most of the tasks faster using commands than using the mouse.
4. The application should respond to user commands within 2 seconds under normal operating conditions.
5. The user interface should be intuitive enough for a first-time user to understand basic functionalities without external help, after loading the User Guide.
6. While primarily designed for one user, the application should be able to handle up to 1000 members efficiently, with room for future enhancements.
7. The application should have a success rate of at least 95% for valid command executions, ensuring that most user actions are completed successfully without errors.
8. Code should be organized and documented to facilitate future updates or modifications.
9. The application should run seamlessly across different operating systems without requiring extensive configuration.

### Glossary

### **HallPointer Developer Glossary**

1. **Hall Points:**\
   Points allocated to members based on attendance and participation in CCA sessions, stored as part of each member's record.

2. **Member:**\
   A participant or member of a CCA (Co-Curricular Activity) in NUS Halls, whose details are tracked in Hall Pointer (e.g. name, telegram, points, and attendance).

3. **Session:**\
   A data model representing an event or activity within a CCA, where attendance is tracked and points are awarded to associated members.

4. **Tag:**\
   Labels or categories assigned to members in Hall Pointer (e.g. `leader`, `active`, `inactive`). Tags help classify and manage members more easily.

5. **Command:**\
   A user-entered instruction (e.g. `add_member`) in the CLI, enabling various operations within HallPointer. Commands are processed by the `Logic` component.

6. **Model Component:**\
   Manages data and business logic within HallPointer, including members, sessions, and hall points. The Model component keeps data in memory for efficient access.

7. **Storage Component:**\
   Responsible for data persistence, handling read/write operations to save members, sessions, and preferences in JSON format.

8. **Logic Component:**\
   Manages command parsing and execution. It receives CLI commands, processes them through parsers, and interacts with the Model to update data.

9. **Parser:**\
   A part of the Logic component that interprets CLI input, converting it into specific command actions that HallPointer can execute.

10. **Gradle:**\
    A build automation tool used for dependency management, compiling code, running tests, and packaging the application. Gradle also supports creating a JAR file for distribution.

11. **JUnit:**\
    A Java testing framework for writing and running tests to validate the functionality of HallPointer's components.

12. **MainApp:**\
    The main entry point for HallPointer, responsible for initializing and starting the application, setting up dependencies between components, and managing the overall flow.

13. **User Preferences:**\
    Settings such as window size and logging levels that can be customized by users and saved in a configuration file (`config.json`) for Hall Pointer.

## **Appendix: Instructions for manual testing**

Given below are instructions to test the application manually.

<box type="info" seamless>

**Note:** These instructions only provide a starting point for testers to work on;
testers are expected to do more _exploratory_ testing.

</box>

### Launch and Shutdown

1. Initial launch

   1. Download the `.jar` file and copy it into an empty folder.
   2. Open a terminal window and navigate to the directory where the `.jar` file is located.
   3. Execute `java -jar hallpointer.jar`.<br>
      **Expected:** Shows the GUI with a set of sample data. Do resize the window if it is not suited for your needs.

2. Saving Window Preferences

   1. Resize the window to your desired size. Move the window to a different location. Close the window.
   2. Re-launch the application by double-clicking the `.jar` file.<br>
      **Expected:** The most recent window size and location is retained.

### Managing Members

1. Adding a member

   1. Test case: `add_member n/May Doe r/4-3-301 t/maydoe123 tag/logistics`<br>
      **Expected:** Adds a contact named "May Doe" with specified room number and tags. Details of the added member shown in the status message.

   2. Test case: `add_member n/John Doe`<br>
      **Expected:** Displays an error message.

2. Deleting a member

   1. Prerequisites: There is at least one displayed member in the list.

   2. Test case: `delete_member 1`<br>
      **Expected:** First contact is deleted from the list. Details of the deleted contact are shown in the status message.

   3. Test case: `delete_member 0`<br>
      **Expected:** No member is deleted. Error details shown in the status message.

   4. Other incorrect delete commands to try: `delete_member`, `delete_member z`, `delete_member #`... (where `z` is an integer larger than the list size).<br>
      **Expected:** Similar to previous.

3. Updating a member

   1. Prerequisites: There is at least one displayed member in the list.
   2. Test case: `update_member 1 t/johndoe123_updated n/John Doe`<br>
      **Expected:** Updates the telegram handle and name for the member at index 1.

   3. Test case: `update_member 2 tag/`<br>
      **Expected:** Clears all tags for the member at index 2, other details remain unchanged.

### Managing Sessions

1. Adding a session

   1. Prerequisites: There is at least one displayed member in the list.
   2. Test case: `add_session s/Rehearsal d/24 Oct 2024 p/2 m/1 m/3`<br>
      **Expected:** Adds a session named "Rehearsal" on 24 Oct 2024 worth 2 points, associated with members at indexes 1 and 3 in the displayed list.

2. Deleting a session

   1. Prerequisites: There is at least one displayed member in the list. Ensure a session with the specified name exists for members.
   2. Test case: `delete_session s/Rehearsal m/1 m/3`<br>
      **Expected:** Deletes the session "Rehearsal" for members at indexes 1 and 3 in the displayed list.

### Saving Data

1. Dealing with missing/corrupted data files

   1. Open the hallpointer.json file located in the data directory (this file is created after the application is first launched). Modify it by deleting the name of the first entry.

      **Expected:** Upon restarting, all data should be cleared, and an empty Hall Pointer should be displayed.

2. Confirming data persistence

   1. Add or modify member/session data.
   2. Exit the application and re-launch it.<br>
      **Expected:** All previous data should be saved and displayed upon restart.

### Other Features

1. Clearing all entries

   1. Test case: `clear`<br>
      **Expected:** Deletes all entries from the Hall Pointer. The list should be empty.

2. Exiting the program

   1. Test case: `exit`<br>
      **Expected:** Closes the application.

3. Viewing help

   1. Test case: `help`<br>
      **Expected:** Displays a message explaining how to access the help page.

## **Planned Enhancements**

Team Size: 5

1. **Support Non-Numeric Room Identifiers**
   Currently, room identifiers must follow the format `block-floor-room number` (e.g. `10-3-100`), and only numeric values are supported for each component. We plan to enhance this feature by allowing non-numeric values for `block`,`floor` and `room number`.

   **Example Requirement**:

   > Room identifier should be in the format `block-floor-room number`, allowing non-numeric values for `block`, `floor` and `room number`:
   >
   > - Example: `A-G-101B`, where `A` represents the block, `G` represents the floor, and `101B` represents the room number.

   This change will add flexibility by supporting alphanumeric characters in the block and room sections.

2. **Partial Search for Session Names**
   Currently, users can only search for sessions by entering the exact first word of the session name using the `find_sessions` command. This can be inconvenient for users who want to list all sessions or search using only part of the session name. We can mitigate this by updating the `find_sessions` command to allow for partial search.

   **Example Requirement**:

   > The `find_sessions` command should allow partial name searches so users can input only the first part of the session name to retrieve all matching sessions.
   >
   > - Example: Searching with the keyword "BAD" would show all sessions starting with "BAD," rather than requiring the exact first word.

   This enhancement will improve user experience by making session searches more flexible and efficient.

3. **Flexible Member Search by Additional Fields**  
   Currently, searching for members by room or other important fields, like the Telegram handle, is not supported.

   **Example Requirement**:

   > Expand the `find_members` command to support searching by additional fields, such as `block/floor/room number`, `Telegram handle` and `Tags`.

   These enhancements will improve the usability of the `find_members` command, making it easier to locate members efficiently by various identifiers or by partial names.

4. **Command Aliases for Improved Usability**
   The current command names (e.g. `add_session`, `add_member`) are lengthy and require the use of underscores, which can be cumbersome for users to type frequently.

   **Example Requirement**:

   > Introduce shorter command aliases as an alternative to full command names to reduce typing effort, especially for frequent actions.
   >
   > - Example: Instead of typing `add_member`, users could simply type `addm` to execute the same command.

   This enhancement will streamline user interaction, making the application more efficient and user-friendly, especially for power users.

5. **`update_session` Command for Session Edits**
   Currently, session details—including members, session name, date, and points—are fixed upon creation and cannot be modified, which is problematic when adjustments are necessary. The current solution is to delete the session and create a new session with the updated details. This can be enhanced through the creation of an `update_session` command.

   **Example Requirement**:

   > Add an `update_session` command to allow users to modify session details after creation, such as adding or removing members, correcting session name or date, and adjusting session points if updated later.
   >
   > - Example: Users should be able to add a member who received a medical absence during the original session creation without creating a duplicate.

   This enhancement will improve flexibility and reduce the need for users to recreate sessions from scratch when updates are required.

6. **Allow Manual Point Adjustments**
   Currently, points can only be awarded or adjusted through sessions. This setup can be restrictive for users who need to manage points directly, without creating a session.

   **Example Requirement**:

   > Update the `update_member` command to manually add or adjust points for individual members, allowing flexible point management outside of sessions.
   >
   > - Example: An `add_points` command could let users award or modify points for members directly, without requiring a session link, accommodating various tracking needs.

   This enhancement would allow users to manage point allocations more flexibly, streamlining adjustments and providing greater control over point tracking.

---
