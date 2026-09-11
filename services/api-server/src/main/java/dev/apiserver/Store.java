package dev.apiserver;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory store for projects, tasks, and comments.
 *
 * <p>Quirk: all timestamps are epoch milliseconds as JSON numbers.
 * This is because the original Java 8 code used {@code System.currentTimeMillis()}
 * everywhere and nobody ever changed it to ISO 8601.
 */
public class Store {

    /** Task status values. Quirk: responses use ordinal (int), requests use name (string). */
    public enum TaskStatus {
        OPEN,       // 0
        IN_PROGRESS, // 1
        REVIEW,     // 2
        DONE,       // 3
        CANCELLED;  // 4

        public static TaskStatus fromName(String name) {
            return TaskStatus.valueOf(name.toUpperCase());
        }

        public static TaskStatus fromOrdinal(int ordinal) {
            return TaskStatus.values()[ordinal];
        }
    }

    public record Project(
        String id,
        String name,
        String description,
        String owner,
        long createdAt,
        long updatedAt
    ) {}

    public record Task(
        String id,
        String projectId,
        String title,
        String description,
        TaskStatus status,
        String assignee,
        int priority,
        long createdAt,
        long updatedAt
    ) {}

    public record Comment(
        String id,
        String taskId,
        String author,
        String body,
        long createdAt
    ) {}

    private final Map<String, Project> projects = new ConcurrentHashMap<>();
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private final Map<String, Comment> comments = new ConcurrentHashMap<>();
    private final AtomicLong counter = new AtomicLong(0);

    private String nextId() {
        return Long.toHexString(System.currentTimeMillis()) + "-" + counter.incrementAndGet();
    }

    // --- Projects ---

    public Project createProject(String name, String description, String owner) {
        var id = nextId();
        var now = System.currentTimeMillis();
        var project = new Project(id, name, description, owner, now, now);
        projects.put(id, project);
        return project;
    }

    public Optional<Project> getProject(String id) {
        return Optional.ofNullable(projects.get(id));
    }

    public List<Project> listProjects(String owner) {
        return projects.values().stream()
            .filter(p -> owner == null || p.owner().equals(owner))
            .sorted(Comparator.comparingLong(Project::updatedAt).reversed())
            .toList();
    }

    /**
     * Update a project. Returns the OLD state (the quirk) and stores the new state.
     *
     * <p>Quirk: PATCH returns the old state, not the new state. A developer misread
     * "return the resource" as "return what it was" and it shipped. Clients adapted.
     * Changing it would break the mobile app.
     */
    public Optional<Project> updateProject(String id, String name, String description) {
        var old = projects.get(id);
        if (old == null) return Optional.empty();

        var updated = new Project(
            old.id(),
            name != null ? name : old.name(),
            description != null ? description : old.description(),
            old.owner(),
            old.createdAt(),
            System.currentTimeMillis()
        );
        projects.put(id, updated);
        return Optional.of(old); // Return the OLD state — the quirk
    }

    /**
     * Delete a project.
     *
     * <p>Quirk: DELETE returns 204 with a body containing {"deleted": true}.
     * A junior developer added the body "for debugging" and it stuck.
     */
    public boolean deleteProject(String id) {
        return projects.remove(id) != null;
    }

    // --- Tasks ---

    public Task createTask(String projectId, String title, String description,
                           String status, String assignee, int priority) {
        var id = nextId();
        var now = System.currentTimeMillis();
        var task = new Task(id, projectId, title, description,
            TaskStatus.fromName(status), assignee, priority, now, now);
        tasks.put(id, task);
        return task;
    }

    public Optional<Task> getTask(String id) {
        return Optional.ofNullable(tasks.get(id));
    }

    /** Lists tasks for one project, or every task when {@code projectId} is null. */
    public List<Task> listTasks(String projectId) {
        return tasks.values().stream()
            .filter(t -> projectId == null || t.projectId().equals(projectId))
            .sorted(Comparator.comparingInt(Task::priority).reversed()
                .thenComparingLong(Task::updatedAt).reversed())
            .toList();
    }

    public Optional<Task> updateTask(String id, String title, String description,
                                     String status, String assignee, Integer priority) {
        var old = tasks.get(id);
        if (old == null) return Optional.empty();

        var updated = new Task(
            old.id(),
            old.projectId(),
            title != null ? title : old.title(),
            description != null ? description : old.description(),
            status != null ? TaskStatus.fromName(status) : old.status(),
            assignee != null ? assignee : old.assignee(),
            priority != null ? priority : old.priority(),
            old.createdAt(),
            System.currentTimeMillis()
        );
        tasks.put(id, updated);
        return Optional.of(old); // Same quirk as projects — returns old state
    }

    public boolean deleteTask(String id) {
        return tasks.remove(id) != null;
    }

    // --- Comments ---

    public Comment createComment(String taskId, String author, String body) {
        var id = nextId();
        var now = System.currentTimeMillis();
        var comment = new Comment(id, taskId, author, body, now);
        comments.put(id, comment);
        return comment;
    }

    public List<Comment> listComments(String taskId) {
        return comments.values().stream()
            .filter(c -> c.taskId().equals(taskId))
            .sorted(Comparator.comparingLong(Comment::createdAt))
            .toList();
    }

    // --- Search ---

    /**
     * Search across projects and tasks.
     *
     * <p>Quirk: returns a single object when there's exactly one result, and an array
     * when there are multiple. This is from an early Jackson configuration with
     * WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED that nobody changed.
     */
    public List<Map<String, Object>> search(String query, int page, int pageSize) {
        var results = new ArrayList<Map<String, Object>>();
        var q = query.toLowerCase();

        for (var p : projects.values()) {
            if (p.name().toLowerCase().contains(q) || p.description().toLowerCase().contains(q)) {
                var map = new LinkedHashMap<String, Object>();
                map.put("type", "project");
                map.put("id", p.id());
                map.put("name", p.name());
                map.put("description", p.description());
                map.put("updatedAt", p.updatedAt());
                results.add(map);
            }
        }

        for (var t : tasks.values()) {
            if (t.title().toLowerCase().contains(q) || t.description().toLowerCase().contains(q)) {
                var map = new LinkedHashMap<String, Object>();
                map.put("type", "task");
                map.put("id", t.id());
                map.put("title", t.title());
                map.put("description", t.description());
                map.put("status", t.status().ordinal());
                map.put("updatedAt", t.updatedAt());
                results.add(map);
            }
        }

        // Paginate (1-based page param — the quirk is in the Link header, which is 0-based)
        int start = (page - 1) * pageSize;
        int end = Math.min(start + pageSize, results.size());
        if (start >= results.size()) return List.of();
        return results.subList(start, end);
    }

    public int searchTotal(String query) {
        var q = query.toLowerCase();
        int count = 0;
        for (var p : projects.values()) {
            if (p.name().toLowerCase().contains(q) || p.description().toLowerCase().contains(q))
                count++;
        }
        for (var t : tasks.values()) {
            if (t.title().toLowerCase().contains(q) || t.description().toLowerCase().contains(q))
                count++;
        }
        return count;
    }
}
