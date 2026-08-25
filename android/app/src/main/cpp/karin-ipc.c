/*
 * karin-ipc: command execution daemon running inside the proot container
 * (static arm64 executable).
 *
 * Binary framed protocol over stdin/stdout, all integers big-endian:
 *   every frame: u32 payloadLen | payload
 *   App -> daemon:
 *     u8 type=1 EXEC: u16 idLen | id | u32 cmdLen | cmd
 *     u8 type=2 KILL: u16 idLen | id
 *     u8 type=3 QUIT: none
 *   daemon -> App:
 *     u8 type=1 OUT:  u16 idLen | id | u8 stream(1=stdout,2=stderr) | u32 dataLen | data
 *     u8 type=2 EXIT: u16 idLen | id | u32 code
 *     u8 type=3 READY: none
 *
 * Payloads are raw bytes, never shell-escaped. Lines longer than MAX_LINE
 * are split into multiple OUT frames. Single-threaded: poll() multiplexes
 * every child stdout/stderr pipe to avoid static-linking pthread TLS issues.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define REQ_EXEC 1
#define REQ_KILL 2
#define REQ_QUIT 3

#define RESP_OUT 1
#define RESP_EXIT 2
#define RESP_READY 3

#define STREAM_STDOUT 1
#define STREAM_STDERR 2

#define MAX_REQUEST (1u << 20) /* request frame cap, 1 MiB */
#define MAX_LINE (1u << 20)    /* single output line cap, split when exceeded */
#define MAX_CHILDREN 64
#define READ_CHUNK 4096

typedef struct {
  char *id;
  pid_t pid;
  int out_fd;
  int err_fd;
  int out_done;
  int err_done;
  unsigned char *line_out;
  size_t line_out_len;
  size_t line_out_cap;
  unsigned char *line_err;
  size_t line_err_len;
  size_t line_err_cap;
} child_t;

static child_t g_children[MAX_CHILDREN];
static int g_child_count = 0;
static volatile sig_atomic_t g_quit = 0;

static unsigned char g_req_buf[MAX_REQUEST + READ_CHUNK + 8];
static size_t g_req_len = 0;

static void handle_signal(int sig) {
  (void)sig;
  g_quit = 1;
}

static uint16_t get_be16(const unsigned char *p) {
  return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static uint32_t get_be32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static void put_be16(unsigned char *p, uint16_t v) {
  p[0] = (unsigned char)(v >> 8);
  p[1] = (unsigned char)v;
}

static void put_be32(unsigned char *p, uint32_t v) {
  p[0] = (unsigned char)(v >> 24);
  p[1] = (unsigned char)(v >> 16);
  p[2] = (unsigned char)(v >> 8);
  p[3] = (unsigned char)v;
}

static int write_all(int fd, const void *buf, size_t len) {
  const unsigned char *p = (const unsigned char *)buf;
  while (len > 0) {
    ssize_t n = write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += n;
    len -= (size_t)n;
  }
  return 0;
}

/* A failed send means the app stopped reading; tear everything down. */
static int send_out(const char *id, int stream, const unsigned char *data, size_t len) {
  size_t id_len = strlen(id);
  if (id_len > 65535 || len > 0xFFFFFFFFu) return -1;
  uint32_t total = 1 + 2 + (uint32_t)id_len + 1 + 4 + (uint32_t)len;
  unsigned char hdr[7];
  put_be32(hdr, total);
  hdr[4] = RESP_OUT;
  put_be16(hdr + 5, (uint16_t)id_len);
  if (write_all(STDOUT_FILENO, hdr, sizeof(hdr)) < 0) return -1;
  if (write_all(STDOUT_FILENO, id, id_len) < 0) return -1;
  unsigned char tail[5];
  tail[0] = (unsigned char)stream;
  put_be32(tail + 1, (uint32_t)len);
  if (write_all(STDOUT_FILENO, tail, sizeof(tail)) < 0) return -1;
  if (len > 0 && write_all(STDOUT_FILENO, data, len) < 0) return -1;
  return 0;
}

static int send_exit(const char *id, uint32_t code) {
  size_t id_len = strlen(id);
  if (id_len > 65535) return -1;
  uint32_t total = 1 + 2 + (uint32_t)id_len + 4;
  unsigned char hdr[7];
  put_be32(hdr, total);
  hdr[4] = RESP_EXIT;
  put_be16(hdr + 5, (uint16_t)id_len);
  if (write_all(STDOUT_FILENO, hdr, sizeof(hdr)) < 0) return -1;
  if (write_all(STDOUT_FILENO, id, id_len) < 0) return -1;
  unsigned char tail[4];
  put_be32(tail, code);
  return write_all(STDOUT_FILENO, tail, sizeof(tail));
}

static void send_ready(void) {
  unsigned char frame[5];
  put_be32(frame, 1);
  frame[4] = RESP_READY;
  (void)write_all(STDOUT_FILENO, frame, sizeof(frame));
}

static void mark_failed_send(void) { g_quit = 1; }

static int ensure_cap(unsigned char **buf, size_t *cap, size_t need) {
  if (*cap >= need) return 0;
  size_t next = *cap ? *cap : 256;
  while (next < need) next *= 2;
  unsigned char *p = (unsigned char *)realloc(*buf, next);
  if (!p) return -1;
  *buf = p;
  *cap = next;
  return 0;
}

static void push_line(child_t *c, int is_err, const unsigned char *data, size_t n, int flush) {
  unsigned char **line = is_err ? &c->line_err : &c->line_out;
  size_t *len = is_err ? &c->line_err_len : &c->line_out_len;
  size_t *cap = is_err ? &c->line_err_cap : &c->line_out_cap;
  int stream = is_err ? STREAM_STDERR : STREAM_STDOUT;

  while (n > 0) {
    size_t room = MAX_LINE - *len;
    size_t take = n < room ? n : room;
    if (ensure_cap(line, cap, *len + take) < 0) {
      *len = 0;
      return;
    }
    memcpy(*line + *len, data, take);
    *len += take;
    data += take;
    n -= take;
    if (*len >= MAX_LINE) {
      if (send_out(c->id, stream, *line, *len) < 0) mark_failed_send();
      *len = 0;
    }
  }
  if (flush && *len > 0) {
    if (send_out(c->id, stream, *line, *len) < 0) mark_failed_send();
    *len = 0;
  }
}

static void feed_output(child_t *c, int is_err, const unsigned char *buf, size_t n) {
  size_t start = 0;
  for (size_t i = 0; i < n; i++) {
    if (buf[i] == '\n') {
      push_line(c, is_err, buf + start, i - start, 1);
      start = i + 1;
    }
  }
  if (start < n) push_line(c, is_err, buf + start, n - start, 0);
}

static void pump_fd(child_t *c, int is_err) {
  int fd;
  if (is_err) {
    if (c->err_done) return;
    fd = c->err_fd;
  } else {
    if (c->out_done) return;
    fd = c->out_fd;
  }
  unsigned char buf[READ_CHUNK];
  ssize_t n = read(fd, buf, sizeof(buf));
  if (n < 0) {
    if (errno == EINTR || errno == EAGAIN) return;
    n = 0;
  }
  if (n == 0) {
    if (is_err) {
      c->err_done = 1;
      if (c->line_err_len > 0) {
        if (send_out(c->id, STREAM_STDERR, c->line_err, c->line_err_len) < 0) mark_failed_send();
        c->line_err_len = 0;
      }
    } else {
      c->out_done = 1;
      if (c->line_out_len > 0) {
        if (send_out(c->id, STREAM_STDOUT, c->line_out, c->line_out_len) < 0) mark_failed_send();
        c->line_out_len = 0;
      }
    }
    close(fd);
    return;
  }
  feed_output(c, is_err, buf, (size_t)n);
}

static child_t *find_by_fd(int fd) {
  for (int i = 0; i < MAX_CHILDREN; i++) {
    child_t *c = &g_children[i];
    if (c->pid && (c->out_fd == fd || c->err_fd == fd)) return c;
  }
  return NULL;
}

static child_t *find_slot(void) {
  for (int i = 0; i < MAX_CHILDREN; i++) {
    if (g_children[i].pid == 0) return &g_children[i];
  }
  return NULL;
}

static void spawn_child(const char *id, const char *cmd) {
  if (g_child_count >= MAX_CHILDREN) {
    if (send_exit(id, 126) < 0) mark_failed_send();
    return;
  }
  int out_pipe[2];
  int err_pipe[2];
  if (pipe(out_pipe) < 0) {
    if (send_exit(id, 127) < 0) mark_failed_send();
    return;
  }
  if (pipe(err_pipe) < 0) {
    close(out_pipe[0]);
    close(out_pipe[1]);
    if (send_exit(id, 127) < 0) mark_failed_send();
    return;
  }
  pid_t pid = fork();
  if (pid < 0) {
    close(out_pipe[0]);
    close(out_pipe[1]);
    close(err_pipe[0]);
    close(err_pipe[1]);
    if (send_exit(id, 127) < 0) mark_failed_send();
    return;
  }
  if (pid == 0) {
    /* Child: own process group, stdout/stderr piped back, stdin /dev/null. */
    setpgid(0, 0);
    dup2(out_pipe[1], 1);
    dup2(err_pipe[1], 2);
    int devnull = open("/dev/null", O_RDONLY);
    if (devnull >= 0) {
      dup2(devnull, 0);
      if (devnull > 2) close(devnull);
    }
    close(out_pipe[0]);
    close(out_pipe[1]);
    close(err_pipe[0]);
    close(err_pipe[1]);
    /* Close inherited pipes from sibling children so their EOF is not delayed. */
    for (int fd = 3; fd < 256; fd++) close(fd);
    execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
    _exit(127);
  }
  /* Parent keeps the read ends; write ends are owned by the child. */
  close(out_pipe[1]);
  close(err_pipe[1]);
  fcntl(out_pipe[0], F_SETFL, O_NONBLOCK);
  fcntl(err_pipe[0], F_SETFL, O_NONBLOCK);
  child_t *c = find_slot();
  if (!c) {
    close(out_pipe[0]);
    close(err_pipe[0]);
    killpg(pid, SIGKILL);
    if (send_exit(id, 126) < 0) mark_failed_send();
    return;
  }
  c->id = strdup(id);
  c->pid = pid;
  c->out_fd = out_pipe[0];
  c->err_fd = err_pipe[0];
  c->out_done = 0;
  c->err_done = 0;
  c->line_out = NULL;
  c->line_out_len = 0;
  c->line_out_cap = 0;
  c->line_err = NULL;
  c->line_err_len = 0;
  c->line_err_cap = 0;
  g_child_count++;
}

static void kill_child(const char *id) {
  for (int i = 0; i < MAX_CHILDREN; i++) {
    child_t *c = &g_children[i];
    if (c->pid && strcmp(c->id, id) == 0) {
      killpg(c->pid, SIGKILL);
      return;
    }
  }
}

static void handle_exec(const unsigned char *body, uint32_t body_len) {
  if (body_len < 2) return;
  uint16_t id_len = get_be16(body);
  uint32_t off = 2;
  if ((uint32_t)off + id_len + 4 > body_len) return;
  const char *id = (const char *)body + off;
  off += id_len;
  uint32_t cmd_len = get_be32(body + off);
  off += 4;
  if ((uint32_t)off + cmd_len > body_len) return;
  const char *cmd = (const char *)body + off;

  char *id_copy = (char *)malloc((size_t)id_len + 1);
  char *cmd_copy = (char *)malloc((size_t)cmd_len + 1);
  if (!id_copy || !cmd_copy) {
    free(id_copy);
    free(cmd_copy);
    return;
  }
  memcpy(id_copy, id, id_len);
  id_copy[id_len] = '\0';
  memcpy(cmd_copy, cmd, cmd_len);
  cmd_copy[cmd_len] = '\0';
  spawn_child(id_copy, cmd_copy);
  free(id_copy);
  free(cmd_copy);
}

static void handle_kill(const unsigned char *body, uint32_t body_len) {
  if (body_len < 2) return;
  uint16_t id_len = get_be16(body);
  if ((uint32_t)2 + id_len > body_len) return;
  char *id = (char *)malloc((size_t)id_len + 1);
  if (!id) return;
  memcpy(id, body + 2, id_len);
  id[id_len] = '\0';
  kill_child(id);
  free(id);
}

static void handle_frame(uint8_t type, const unsigned char *body, uint32_t body_len) {
  switch (type) {
    case REQ_QUIT:
      g_quit = 1;
      break;
    case REQ_EXEC:
      handle_exec(body, body_len);
      break;
    case REQ_KILL:
      handle_kill(body, body_len);
      break;
    default:
      break;
  }
}

static void consume_frames(void) {
  size_t off = 0;
  while (1) {
    if (g_req_len - off < 4) break;
    uint32_t len = get_be32(g_req_buf + off);
    if (len < 1 || len > MAX_REQUEST) {
      g_quit = 1;
      return;
    }
    if (g_req_len - off < 4u + len) break;
    uint8_t type = g_req_buf[off + 4];
    handle_frame(type, g_req_buf + off + 5, len - 1);
    off += 4u + len;
  }
  if (off > 0) {
    memmove(g_req_buf, g_req_buf + off, g_req_len - off);
    g_req_len -= off;
  }
}

static void handle_stdin(void) {
  for (;;) {
    if (g_req_len >= sizeof(g_req_buf)) {
      g_quit = 1;
      return;
    }
    ssize_t n = read(STDIN_FILENO, g_req_buf + g_req_len, sizeof(g_req_buf) - g_req_len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) break;
      g_quit = 1;
      return;
    }
    if (n == 0) {
      g_quit = 1;
      return;
    }
    g_req_len += (size_t)n;
  }
  consume_frames();
}

static int reap_children(void) {
  for (int i = 0; i < MAX_CHILDREN; i++) {
    child_t *c = &g_children[i];
    if (!c->pid || !c->out_done || !c->err_done) continue;
    int status = 0;
    pid_t r = waitpid(c->pid, &status, WNOHANG);
    if (r < 0) {
      if (errno == EINTR) continue;
      if (send_exit(c->id, 1) < 0) return -1;
    } else if (r == 0) {
      continue;
    } else {
      int code = WIFEXITED(status) ? WEXITSTATUS(status)
                  : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1);
      if (send_exit(c->id, (uint32_t)code) < 0) return -1;
    }
    free(c->id);
    free(c->line_out);
    free(c->line_err);
    memset(c, 0, sizeof(*c));
    g_child_count--;
  }
  return 0;
}

static void shutdown_all(void) {
  for (int i = 0; i < MAX_CHILDREN; i++) {
    child_t *c = &g_children[i];
    if (!c->pid) continue;
    killpg(c->pid, SIGKILL);
    waitpid(c->pid, NULL, 0);
    free(c->id);
    free(c->line_out);
    free(c->line_err);
    if (!c->out_done) close(c->out_fd);
    if (!c->err_done) close(c->err_fd);
    memset(c, 0, sizeof(*c));
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, handle_signal);
  signal(SIGINT, handle_signal);
  fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
  send_ready();

  while (!g_quit) {
    if (reap_children() < 0) {
      g_quit = 1;
      break;
    }
    struct pollfd fds[MAX_CHILDREN * 2 + 1];
    nfds_t nfds = 0;
    fds[nfds].fd = STDIN_FILENO;
    fds[nfds].events = POLLIN;
    fds[nfds].revents = 0;
    nfds++;
    for (int i = 0; i < MAX_CHILDREN; i++) {
      child_t *c = &g_children[i];
      if (!c->pid) continue;
      if (!c->out_done) {
        fds[nfds].fd = c->out_fd;
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;
      }
      if (!c->err_done) {
        fds[nfds].fd = c->err_fd;
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;
      }
    }
    int r = poll(fds, nfds, 1000);
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (r == 0) continue;
    for (nfds_t i = 0; i < nfds; i++) {
      if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      if (fds[i].fd == STDIN_FILENO) {
        handle_stdin();
        continue;
      }
      child_t *c = find_by_fd(fds[i].fd);
      if (c) pump_fd(c, fds[i].fd == c->err_fd);
    }
  }

  shutdown_all();
  return 0;
}
