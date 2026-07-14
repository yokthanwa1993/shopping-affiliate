import SwiftUI

// MARK: - หน้าแรก: เลือกแพลตฟอร์ม
struct ContentView: View {
    @StateObject private var hub = Hub()

    var body: some View {
        NavigationStack {
            ZStack {
                Color(.systemGroupedBackground).ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Accounts").font(.largeTitle.bold())
                            Text("จัดการบัญชีของแต่ละแพลตฟอร์ม").font(.subheadline).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 4)

                        ForEach(Platform.allCases) { p in
                            NavigationLink { AccountListView(store: hub.store(for: p)) } label: {
                                PlatformCard(platform: p)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct PlatformCard: View {
    let platform: Platform
    var body: some View {
        HStack(spacing: 14) {
            Image(platform.logoAsset).resizable().scaledToFill()
                .frame(width: 52, height: 52)
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(platform.title).font(.headline).foregroundStyle(.primary)
                Text(platform.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.bold()).foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemGroupedBackground)))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 3)
    }
}

// MARK: - หน้าบัญชีของแพลตฟอร์มนั้น
struct AccountListView: View {
    @ObservedObject var store: SessionStore
    @State private var renameTarget: Account?
    @State private var renameText = ""
    @State private var showRename = false

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.platform.title).font(.largeTitle.bold())
                        Text("\(store.accounts.count) โปรไฟล์").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 4)

                    ForEach(store.accounts) { a in
                        NavigationLink { AccountWebView(store: store, account: a) } label: {
                            ProfileCard(platform: store.platform, account: a)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            NavigationLink { CredentialsView(store: store, account: a) } label: {
                                Label("ใส่ user / pass / 2FA", systemImage: "key.fill")
                            }
                            Button {
                                renameTarget = a; renameText = a.label; showRename = true
                            } label: { Label("แก้ไขชื่อ", systemImage: "pencil") }
                            Button(role: .destructive) {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { store.removeAccount(a.id) }
                            } label: { Label("ลบบัญชี", systemImage: "trash") }
                        }
                    }
                }
                .padding(20)
            }
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.addAccount() } label: { Label("เพิ่มบัญชี", systemImage: "plus") }
            }
        }
        .alert("ตั้งชื่อบัญชี", isPresented: $showRename) {
            TextField("ชื่อ / อีเมล", text: $renameText)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("บันทึก") { if let t = renameTarget { store.setLabel(t.id, renameText) } }
            Button("ยกเลิก", role: .cancel) { }
        } message: { Text("ตั้งชื่อเองเพื่อให้รู้ว่าเป็นบัญชีไหน") }
    }
}

struct ProfileCard: View {
    let platform: Platform
    let account: Account
    private var loggedIn: Bool { !account.accId.isEmpty }
    private var displayTitle: String {
        !account.label.isEmpty ? account.label : (account.pic.isEmpty ? platform.title : account.name)
    }
    // โชว์บรรทัด "ID:" เฉพาะตอนยังไม่ตั้งชื่อเอง + ไม่ใช่ higgsfield
    private var showIdLine: Bool { platform != .higgsfield && account.label.isEmpty }

    var body: some View {
        HStack(spacing: 14) {
            avatar.opacity(loggedIn ? 1 : 0.35)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(displayTitle).font(.headline).foregroundStyle(.primary)
                    if !showIdLine {
                        Circle().fill(loggedIn ? .green : .orange).frame(width: 7, height: 7)
                    }
                }
                if showIdLine {
                    HStack(spacing: 5) {
                        Circle().fill(loggedIn ? .green : .orange).frame(width: 7, height: 7)
                        Text(loggedIn ? "ID: \(account.accId)" : "ยังไม่ login")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.bold()).foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemGroupedBackground)))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 3)
    }

    @ViewBuilder private var avatar: some View {
        if !account.pic.isEmpty, let url = URL(string: account.pic) {
            AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { logoCircle }
                .frame(width: 52, height: 52).clipShape(Circle())
        } else {
            logoCircle
        }
    }
    private var logoCircle: some View {
        Image(platform.logoAsset).resizable().scaledToFill()
            .frame(width: 52, height: 52)
            .clipShape(Circle())
    }
}

// MARK: - หน้า WebView ของบัญชี
struct AccountWebView: View {
    @ObservedObject var store: SessionStore
    let account: Account

    var body: some View {
        WebView(webView: store.webView(for: account.id))
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .bottom) {
                if !store.toast.isEmpty {
                    Text(store.toast).font(.callout).foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Capsule().fill(.black.opacity(0.85)))
                        .padding(.bottom, 30)
                }
            }
            .animation(.easeInOut, value: store.toast)
            .navigationTitle(account.accId.isEmpty ? store.platform.title : account.accId)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink { CredentialsView(store: store, account: account) } label: {
                        Image(systemName: "key.fill")
                    }
                    Button {
                        store.toast = "🔄 รีเฟรช + ส่ง session..."
                        store.webView(for: account.id).reload()
                    } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .onAppear { store.currentID = account.id }
    }
}

// MARK: - หน้ากรอก user/pass/2FA (master credential)
struct CredentialsView: View {
    @ObservedObject var store: SessionStore
    let account: Account
    @Environment(\.dismiss) private var dismiss

    @State private var uid = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var password = ""
    @State private var twoFA = ""
    @State private var datr = ""
    @State private var showPass = false
    @State private var loaded = false

    var body: some View {
        Form {
            Section("บัญชี") {
                field("UID (c_user)", $uid, kb: .numberPad)
                field("Email", $email, kb: .emailAddress)
            }
            Section {
                HStack {
                    if showPass { TextField("Password", text: $password) }
                    else { SecureField("Password", text: $password) }
                    Button { showPass.toggle() } label: {
                        Image(systemName: showPass ? "eye.slash" : "eye").foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                field("2FA Secret (base32)", $twoFA)
                field("datr", $datr)
            }
            Section {
                Button {
                    saveAll()
                    store.syncCredentials(account.id)
                } label: { Label("บันทึก + ส่งขึ้น bridge", systemImage: "arrow.up.circle.fill") }
                Button {
                    saveAll()
                    store.reLogin(account.id)
                } label: { Label("Re-login (mint FB Lite token)", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(password.isEmpty)
            }
        }
        .navigationTitle("ข้อมูล Login").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("บันทึก") { saveAll(); dismiss() }.bold()
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            uid = account.uid.isEmpty ? account.accId : account.uid
            email = account.email; phone = account.phone
            let s = store.secret(for: account.id)
            password = s.password; twoFA = s.twoFA
            datr = s.datr.isEmpty ? store.datrFromCookie(account.id) : s.datr
        }
    }

    private func field(_ label: String, _ text: Binding<String>, kb: UIKeyboardType = .default) -> some View {
        TextField(label, text: text)
            .keyboardType(kb)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
    }

    private func saveAll() {
        store.setInfo(account.id, uid: uid, email: email, phone: phone)
        store.setSecret(account.id, Secret(password: password, twoFA: twoFA, datr: datr))
    }
}
